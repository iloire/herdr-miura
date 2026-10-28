//! Tauri commands: the webview's whole surface into the daemon. Each one only
//! queues work on `herdr-client`'s bounded command queue; none blocks.

use crate::{Error, Result, connection::Connection};
use herdr_client::{
    ConnectOptions, Method,
    protocol::{ClientPaneInputEvent, ClientSurfaceSize},
};
use herdr_commands::COMMANDS;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, State,
    ipc::{Channel, InvokeResponseBody},
};

/// The grid the webview can show and the cell it measured, in CSS pixels.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Surface {
    cols: u16,
    rows: u16,
    cell_width_px: u32,
    cell_height_px: u32,
}

impl From<Surface> for ConnectOptions {
    fn from(surface: Surface) -> Self {
        Self {
            surface_size: ClientSurfaceSize {
                cols: surface.cols,
                rows: surface.rows,
            },
            cell_width_px: surface.cell_width_px,
            cell_height_px: surface.cell_height_px,
        }
    }
}

#[derive(Serialize)]
pub struct CatalogEntry {
    name: &'static str,
    label: &'static str,
    /// GPUI keystroke syntax, such as `cmd-shift-d`.
    shortcuts: &'static [&'static str],
}

/// The endpoint methods the webview may call directly, beyond the catalog.
const METHODS: &[Method] = &[
    // keep-sorted start
    Method::LayoutSetSplitRatio,
    Method::PaneClose,
    Method::PaneFocus,
    Method::PaneRename,
    Method::PaneScroll,
    Method::PaneSplit,
    Method::PaneZoom,
    Method::TabClose,
    Method::TabCreate,
    Method::TabFocus,
    Method::TabMove,
    Method::TabRename,
    Method::WorkspaceClose,
    Method::WorkspaceCreate,
    Method::WorkspaceFocus,
    Method::WorkspaceMove,
    Method::WorkspaceRename,
    // keep-sorted end
];

fn method(name: &str) -> Result<Method> {
    METHODS
        .iter()
        .copied()
        .find(|method| method.as_str() == name)
        .ok_or_else(|| Error::UnknownMethod(name.into()))
}

#[tauri::command]
pub fn catalog() -> Vec<CatalogEntry> {
    COMMANDS
        .iter()
        .map(|info| CatalogEntry {
            name: info.name,
            label: info.label,
            shortcuts: info.default_shortcuts(),
        })
        .collect()
}

#[tauri::command]
pub fn connect(
    app: AppHandle,
    connection: State<'_, Connection>,
    surface: Surface,
    events: Channel<InvokeResponseBody>,
) -> Result<()> {
    connection.connect(app, surface.into(), events)
}

#[tauri::command]
pub fn disconnect(connection: State<'_, Connection>) {
    connection.disconnect();
}

#[tauri::command]
pub fn resize(connection: State<'_, Connection>, boot_id: &str, surface: Surface) -> Result<()> {
    Ok(connection.handle()?.resize(boot_id, surface.into())?)
}

#[tauri::command]
pub fn set_focus(connection: State<'_, Connection>, boot_id: &str, focused: bool) -> Result<()> {
    Ok(connection.handle()?.set_focus(boot_id, focused)?)
}

#[tauri::command]
pub fn send_input(
    connection: State<'_, Connection>,
    boot_id: &str,
    pane_id: &str,
    events: Vec<ClientPaneInputEvent>,
) -> Result<()> {
    Ok(connection.handle()?.send_input(boot_id, pane_id, events)?)
}

#[tauri::command]
pub fn send_popup_input(
    connection: State<'_, Connection>,
    boot_id: &str,
    terminal_id: &str,
    events: Vec<ClientPaneInputEvent>,
) -> Result<()> {
    Ok(connection
        .handle()?
        .send_popup_input(boot_id, terminal_id, events)?)
}

/// Queues an endpoint request; the answer arrives as a `response` event
/// carrying the returned ID.
#[tauri::command]
pub fn request(
    connection: State<'_, Connection>,
    boot_id: &str,
    method: &str,
    params: Value,
) -> Result<String> {
    Ok(connection.handle()?.request(boot_id, self::method(method)?, params)?)
}

/// Runs a catalog command against the latest snapshot, the same request
/// herdr-gpui sends for it. Commands that live in the window are refused,
/// and the webview runs those itself.
#[tauri::command]
pub fn run_command(connection: State<'_, Connection>, name: &str) -> Result<String> {
    let info = COMMANDS
        .iter()
        .find(|info| info.name == name)
        .ok_or_else(|| Error::UnknownCommand(name.into()))?;
    let snapshot = connection
        .snapshot()
        .ok_or_else(|| Error::NoSnapshot(name.into()))?;
    let (method, params) = herdr_commands::request(info.command, &snapshot)
        .ok_or_else(|| Error::WindowCommand(name.into()))?;
    Ok(connection.handle()?.request(&snapshot.boot_id, method, params)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn methods_parse_from_their_wire_names() {
        for known in METHODS {
            assert_eq!(method(known.as_str()).ok(), Some(*known));
        }
        assert!(matches!(method("pane.nuke"), Err(Error::UnknownMethod(_))));
    }

    #[test]
    fn catalog_names_are_unique() {
        let entries = catalog();
        let mut names: Vec<_> = entries.iter().map(|entry| entry.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), entries.len());
    }
}

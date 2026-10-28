//! Tauri commands: the webview's whole surface into the daemon. Each one only
//! queues work on the connection's bounded command queue; none blocks.

use crate::{
    Error, Result,
    changes::{self, CheckoutView, CommitFilesView, FileDiff},
    connection::Connection,
    folder::{self, Opener},
};
use crate::herdr::{
    ConnectOptions,
    wire::{ClientPaneInputEvent, ClientSurfaceSize},
};
use serde::Deserialize;
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

/// The endpoint methods the webview may call: its own requests and the
/// ones its command catalog (`src/app/catalog.ts`) builds.
const METHODS: &[&str] = &[
    // keep-sorted start
    "layout.set_split_ratio",
    "pane.clear",
    "pane.close",
    "pane.edit_scrollback",
    "pane.focus",
    "pane.focus_direction",
    "pane.rename",
    "pane.resize",
    "pane.scroll",
    "pane.split",
    "pane.swap",
    "pane.zoom",
    "tab.close",
    "tab.create",
    "tab.focus",
    "tab.move",
    "tab.rename",
    "workspace.close",
    "workspace.create",
    "workspace.focus",
    "workspace.move",
    "workspace.rename",
    // keep-sorted end
];

fn method(name: &str) -> Result<&'static str> {
    METHODS
        .iter()
        .copied()
        .find(|method| *method == name)
        .ok_or_else(|| Error::UnknownMethod(name.into()))
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

/// The checkout `directory` sits in, or `None` outside Git. Git runs on the
/// blocking pool, never the main thread.
#[tauri::command]
pub async fn checkout_changes(directory: String) -> Result<Option<CheckoutView>> {
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_checkout(&directory));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

#[tauri::command]
pub async fn change_counts(directories: Vec<String>) -> Result<Vec<Option<usize>>> {
    let read = tauri::async_runtime::spawn_blocking(move || changes::count_changes(&directories));
    Ok(read.await.map_err(changes::Error::Worker)?)
}

#[tauri::command]
pub async fn commit_files(checkout: String, sha: String) -> Result<CommitFilesView> {
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_commit(&checkout, &sha));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// One file's diff: its uncommitted change, or with `commit`, its change in that commit.
#[tauri::command]
pub async fn file_diff(
    checkout: String,
    path: String,
    untracked: bool,
    commit: Option<String>,
) -> Result<FileDiff> {
    let read = tauri::async_runtime::spawn_blocking(move || {
        changes::read_diff(&checkout, &path, untracked, commit.as_deref())
    });
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// Moves a tab's panes into a new tab of another workspace through the
/// `herdr` CLI, on the blocking pool since it waits on child processes.
#[tauri::command]
pub async fn move_tab(
    panes: Vec<String>,
    workspace_id: String,
    label: Option<String>,
) -> Result<()> {
    let run = tauri::async_runtime::spawn_blocking(move || {
        crate::tab_move::move_tab(&panes, &workspace_id, label.as_deref())
    });
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Opens a workspace's folder in the file manager or one of a few known apps.
#[tauri::command]
pub fn open_folder(path: String, with: Opener) -> Result<()> {
    Ok(folder::open(&path, with)?)
}

/// Copies a workspace's folder path, after checking it names a folder.
#[tauri::command]
pub fn copy_path(app: AppHandle, path: String) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    folder::folder(&path)?;
    app.clipboard()
        .write_text(path)
        .map_err(folder::Error::Clipboard)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn methods_parse_from_their_wire_names() {
        for known in METHODS {
            assert_eq!(method(known).ok(), Some(*known));
        }
        assert!(matches!(method("pane.nuke"), Err(Error::UnknownMethod(_))));
    }
}

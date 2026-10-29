//! Tauri commands: the webview's whole surface into the daemon. Each one only
//! queues work on the connection's bounded command queue; none blocks.

use crate::{
    Error, Result,
    changes::{self, CheckoutView, CommitFilesView, FileDiff},
    claude_usage,
    connection::Connection,
    files::{self, Contents, Listing},
    folder::{self, Opener},
    listening_ports,
    session_usage::{self, SessionUsage},
    ssh_hosts,
    worktrees,
};
use crate::herdr::{
    ConnectOptions, Target,
    wire::{ClientPaneInputEvent, ClientSurfaceSize},
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{
    AppHandle, Manager, State,
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
    host: Option<String>,
    events: Channel<InvokeResponseBody>,
) -> Result<()> {
    let target = host.map_or(Target::Local, Target::Ssh);
    connection.connect(app, target, surface.into(), events)
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
    Ok(connection
        .handle()?
        .request(boot_id, self::method(method)?, params)?)
}

/// The checkout `directory` sits in, or `None` outside Git. Git runs on the
/// blocking pool, never the main thread.
#[tauri::command]
pub async fn checkout_changes(
    connection: State<'_, Connection>,
    directory: String,
) -> Result<Option<CheckoutView>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_checkout(&directory));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

#[tauri::command]
pub async fn change_counts(
    connection: State<'_, Connection>,
    directories: Vec<String>,
) -> Result<Vec<Option<usize>>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || changes::count_changes(&directories));
    Ok(read.await.map_err(changes::Error::Worker)?)
}

#[tauri::command]
pub async fn commit_files(
    connection: State<'_, Connection>,
    checkout: String,
    sha: String,
) -> Result<CommitFilesView> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_commit(&checkout, &sha));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// One file's diff: its uncommitted change, or with `commit`, its change in that commit.
#[tauri::command]
pub async fn file_diff(
    connection: State<'_, Connection>,
    checkout: String,
    path: String,
    untracked: bool,
    commit: Option<String>,
) -> Result<FileDiff> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || {
        changes::read_diff(&checkout, &path, untracked, commit.as_deref())
    });
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// This Mac's Claude plan usage, whichever host the window is connected to:
/// the account is the user's, not the host's.
#[tauri::command]
pub async fn claude_usage(app: AppHandle) -> Result<Option<claude_usage::Usage>> {
    let read = tauri::async_runtime::spawn_blocking(move || app.state::<claude_usage::Cache>().read());
    Ok(read.await.map_err(claude_usage::Error::Worker)?)
}

/// The TCP ports each workspace's processes listen on, by workspace id.
#[tauri::command]
pub async fn listening_ports(
    connection: State<'_, Connection>,
) -> Result<HashMap<String, Vec<listening_ports::Port>>> {
    connection.ensure_local()?;
    let scan = tauri::async_runtime::spawn_blocking(listening_ports::scan);
    Ok(scan.await.map_err(listening_ports::Error::Worker)??)
}

/// The linked worktrees of each directory's checkout; `None` outside Git.
#[tauri::command]
pub async fn worktrees(
    connection: State<'_, Connection>,
    directories: Vec<String>,
) -> Result<Vec<Option<Vec<worktrees::Worktree>>>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || worktrees::list(&directories));
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// Each Claude Code session's token use, by session id; `None` for one whose
/// transcript is not in `~/.claude/projects` or cannot be read. The
/// transcripts are this Mac's, as the panes are.
#[tauri::command]
pub async fn session_usage(
    app: AppHandle,
    connection: State<'_, Connection>,
    sessions: Vec<String>,
) -> Result<Vec<Option<SessionUsage>>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || {
        let Some(home) = std::env::var_os("HOME") else {
            return vec![None; sessions.len()];
        };
        let projects = std::path::Path::new(&home).join(".claude/projects");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs() as i64);
        app.state::<session_usage::Cache>().read(&projects, &sessions, now)
    });
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// Every file of the checkout `directory` sits in, or `None` outside Git.
#[tauri::command]
pub async fn list_files(
    connection: State<'_, Connection>,
    directory: String,
) -> Result<Option<Listing>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || files::list(&directory));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// One file of the checkout at `root`, for the file view.
#[tauri::command]
pub async fn read_file(
    connection: State<'_, Connection>,
    root: String,
    path: String,
) -> Result<Contents> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || files::read(&root, &path));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// Moves a tab's panes into a new tab of another workspace through the
/// `herdr` CLI, on the blocking pool since it waits on child processes.
#[tauri::command]
pub async fn move_tab(
    connection: State<'_, Connection>,
    panes: Vec<String>,
    workspace_id: String,
    label: Option<String>,
) -> Result<()> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        crate::tab_move::move_tab(&panes, &workspace_id, label.as_deref())
    });
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Writes a starter team into a workspace's folder: the team file and an
/// agent per role, keeping any agent file the repo already has.
#[tauri::command]
pub fn create_team(connection: State<'_, Connection>, directory: String) -> Result<Vec<String>> {
    connection.ensure_local()?;
    Ok(crate::team::create(&directory)?)
}

/// Opens a tab per team member in a workspace and starts its agent there,
/// through the `herdr` CLI, on the blocking pool since it waits on child processes.
#[tauri::command]
pub async fn start_team(
    connection: State<'_, Connection>,
    workspace_id: String,
    directory: String,
    members: Vec<crate::team::Member>,
) -> Result<()> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        crate::team::start(&workspace_id, &directory, &members)
    });
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Opens a workspace's folder in the file manager or one of a few known apps.
#[tauri::command]
pub fn open_folder(connection: State<'_, Connection>, path: String, with: Opener) -> Result<()> {
    connection.ensure_local()?;
    Ok(folder::open(&path, with)?)
}

/// Copies a workspace's folder path, after checking it names a folder.
#[tauri::command]
pub fn copy_path(app: AppHandle, connection: State<'_, Connection>, path: String) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    // A remote folder cannot be checked here; its path is still worth copying.
    if connection.is_remote() {
        folder::remote_path(&path)?;
    } else {
        folder::folder(&path)?;
    }
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

/// The named hosts of `~/.ssh/config`, for the host picker.
#[tauri::command]
pub async fn ssh_hosts() -> Result<Vec<String>> {
    let read = tauri::async_runtime::spawn_blocking(ssh_hosts::list);
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// Fetches a host's keys for the user to compare before trusting them.
#[tauri::command]
pub async fn scan_host_key(
    pending: State<'_, ssh_hosts::PendingKeys>,
    host: String,
) -> Result<Vec<ssh_hosts::Fingerprint>> {
    let pending = pending.inner().clone();
    let scan = tauri::async_runtime::spawn_blocking(move || ssh_hosts::scan(&pending, &host));
    Ok(scan.await.map_err(changes::Error::Worker)??)
}

/// Writes the keys `scan_host_key` showed to known_hosts, after the user approved them.
#[tauri::command]
pub fn trust_host_key(pending: State<'_, ssh_hosts::PendingKeys>, host: String) -> Result<()> {
    Ok(ssh_hosts::trust(&pending, &host)?)
}

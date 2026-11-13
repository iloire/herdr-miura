//! Tauri commands: the webview's whole surface into the daemon. Each one only
//! queues work on the connection's bounded command queue; none blocks.

use crate::{
    Error, Result, branch_ops,
    commit_ops,
    changes::{self, CheckoutView, CommitFilesView, CommitView, FileDiff, FoundCommit},
    claude_usage,
    connection::Connection,
    files::{self, Contents, FoundFile, Listing},
    folder::{self, FileAction, Opener},
    forge,
    land, ledger, listening_ports, open_sessions,
    pasted_image::{self, PastedImage},
    prompts, queue,
    session_context::{self, SessionContext},
    recent_sessions::{self, RecentSession},
    session_usage::{self, ProjectUsage, SessionUsage},
    settings,
    ssh_hosts,
    sync,
    todoist,
    tab_move::Destination,
    worktree_ops,
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
/// `commits` is how many recent commits to list, as "load more" grows it.
#[tauri::command]
pub async fn checkout_changes(
    connection: State<'_, Connection>,
    directory: String,
    commits: Option<usize>,
) -> Result<Option<CheckoutView>> {
    let target = connection.target();
    let commits = commits.unwrap_or(0);
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_checkout(&target, &directory, commits));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// The checkout's local branches and the merged ones a delete may offer.
#[tauri::command]
pub async fn branches(connection: State<'_, Connection>, directory: String) -> Result<changes::branches::BranchesView> {
    let target = connection.target();
    let read = tauri::async_runtime::spawn_blocking(move || changes::branches::read_branches(&target, &directory));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// The last commits that changed one file.
#[tauri::command]
pub async fn file_history(
    connection: State<'_, Connection>,
    checkout: String,
    path: String,
) -> Result<Vec<CommitView>> {
    let target = connection.target();
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_history(&target, &checkout, &path));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// Switches the checkout from `branch`, the one on show, to `to`. Refused on
/// a remote host, and by the backend on a dirty tree.
#[tauri::command]
pub async fn switch_branch(
    app: AppHandle,
    connection: State<'_, Connection>,
    checkout: String,
    to: String,
    branch: Option<String>,
) -> Result<sync::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        branch_ops::switch_branch(&app.state::<sync::Running>(), &checkout, &to, branch.as_deref())
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// Checks a commit out on a detached HEAD. Refused on a remote host, and by
/// the backend on a dirty tree or with an operation under way.
#[tauri::command]
pub async fn checkout_commit(
    app: AppHandle,
    connection: State<'_, Connection>,
    checkout: String,
    sha: String,
) -> Result<sync::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        commit_ops::checkout_commit(&app.state::<sync::Running>(), &checkout, &sha)
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// Starts the branch `name` at a commit and switches to it, under the same
/// checks as [`checkout_commit`].
#[tauri::command]
pub async fn branch_from_commit(
    app: AppHandle,
    connection: State<'_, Connection>,
    checkout: String,
    sha: String,
    name: String,
) -> Result<sync::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        commit_ops::branch_from(&app.state::<sync::Running>(), &checkout, &sha, &name)
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// Adds a commit undoing `sha` on `branch`, the branch the panel showed.
#[tauri::command]
pub async fn revert_commit(
    app: AppHandle,
    connection: State<'_, Connection>,
    checkout: String,
    sha: String,
    branch: Option<String>,
) -> Result<sync::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        commit_ops::revert_commit(&app.state::<sync::Running>(), &checkout, &sha, branch.as_deref())
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// Deletes a merged local branch with `git branch -d`.
#[tauri::command]
pub async fn delete_branch(
    app: AppHandle,
    connection: State<'_, Connection>,
    checkout: String,
    name: String,
) -> Result<sync::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        branch_ops::delete_branch(&app.state::<sync::Running>(), &checkout, &name)
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
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
    let target = connection.target();
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_commit(&target, &checkout, &sha));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// The commit a hash in a pane's text names from that pane's folder.
#[tauri::command]
pub async fn find_commit(
    connection: State<'_, Connection>,
    directory: String,
    name: String,
) -> Result<Option<FoundCommit>> {
    let target = connection.target();
    let read = tauri::async_runtime::spawn_blocking(move || changes::find_commit(&target, &directory, &name));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// GitHub's word on a branch: its open pull request and HEAD's checks, through
/// `gh`. Asked on its own call, never with the panel's reads, as it waits on
/// the network. `None` on a remote host and whenever `gh` cannot answer.
#[tauri::command]
pub async fn forge_status(
    connection: State<'_, Connection>,
    checkout: String,
    branch: String,
    sha: String,
) -> Result<Option<forge::ForgeStatus>> {
    if connection.ensure_local().is_err() {
        return Ok(None);
    }
    let read = tauri::async_runtime::spawn_blocking(move || forge::status(&checkout, &branch, &sha));
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// The commits a push or a pull would move, as the last fetch knows them.
#[tauri::command]
pub async fn moving_commits(
    connection: State<'_, Connection>,
    checkout: String,
    direction: changes::Direction,
) -> Result<Vec<CommitView>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_moving(&checkout, direction));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// Fetches, pushes, publishes or pulls. Refused on a remote host, where the
/// panel only reads: Git would need the host's credentials. `branch` is the one the panel showed, and
/// a checkout that has moved off it is left alone.
/// What discarding `path` would do, with the fingerprint a discard must match.
#[tauri::command]
pub async fn discard_plan(
    connection: State<'_, Connection>,
    checkout: String,
    path: String,
    branch: Option<String>,
) -> Result<worktree_ops::Plan> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || {
        worktree_ops::discard_plan(&checkout, &path, branch.as_deref())
    });
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// Discards `path`, unless it no longer matches `fingerprint`.
#[tauri::command]
pub async fn discard_file(
    app: AppHandle,
    connection: State<'_, Connection>,
    checkout: String,
    path: String,
    fingerprint: String,
    branch: Option<String>,
) -> Result<sync::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        worktree_ops::discard_file(
            &app.state::<sync::Running>(),
            &checkout,
            &path,
            &fingerprint,
            branch.as_deref(),
        )
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// Commits `paths` and nothing else, on the branch on show.
#[tauri::command]
pub async fn commit_paths(
    app: AppHandle,
    connection: State<'_, Connection>,
    checkout: String,
    paths: Vec<String>,
    message: String,
    branch: Option<String>,
) -> Result<sync::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        worktree_ops::commit_paths(
            &app.state::<sync::Running>(),
            &checkout,
            &paths,
            &message,
            branch.as_deref(),
        )
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
}

#[tauri::command]
pub async fn sync_checkout(
    app: AppHandle,
    connection: State<'_, Connection>,
    checkout: String,
    op: sync::Op,
    branch: Option<String>,
) -> Result<sync::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        sync::run(&app.state::<sync::Running>(), &checkout, op, branch.as_deref())
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// What landing a worktree would do, or why it cannot, for the confirmation.
/// Refused on a remote host, as the worktree is a folder over there.
#[tauri::command]
pub async fn land_plan(connection: State<'_, Connection>, worktree: String) -> Result<land::Plan> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || land::plan(&worktree));
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// Runs the repo's check in a confirmed worktree. The webview looks at the
/// worktree's agents again before it calls [`land_finish`]: a check can take
/// minutes, and only the webview has the snapshot.
#[tauri::command]
pub async fn land_check(connection: State<'_, Connection>, target: land::Target) -> Result<land::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || land::check(&target));
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// Rebases, fast-forwards main and removes the worktree and branch, reporting
/// each step on `steps` as it starts.
#[tauri::command]
pub async fn land_finish(
    connection: State<'_, Connection>,
    target: land::Target,
    steps: Channel<land::Step>,
) -> Result<land::Outcome> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        land::finish(&target, |step| {
            let _ = steps.send(step);
        })
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
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
    let target = connection.target();
    let read = tauri::async_runtime::spawn_blocking(move || {
        changes::read_diff(&target, &checkout, &path, untracked, commit.as_deref())
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

/// The Todoist tasks `filter` matches, for the Todoist panel.
#[tauri::command]
pub async fn todoist_tasks(app: AppHandle, filter: String) -> Result<todoist::Tasks> {
    let read = tauri::async_runtime::spawn_blocking(move || app.state::<todoist::Cache>().tasks(&filter));
    Ok(read.await.map_err(todoist::Error::Worker)??)
}

/// Adds `task` to the Todoist project named `project`, else the Inbox.
#[tauri::command]
pub async fn todoist_add(app: AppHandle, task: todoist::NewTask, project: Option<String>) -> Result<todoist::Task> {
    let run = tauri::async_runtime::spawn_blocking(move || app.state::<todoist::Cache>().add(&task, project.as_deref()));
    Ok(run.await.map_err(todoist::Error::Worker)??)
}

/// The comments on the Todoist task `task`, oldest first.
#[tauri::command]
pub async fn todoist_comments(task: String) -> Result<Vec<todoist::Comment>> {
    let read = tauri::async_runtime::spawn_blocking(move || todoist::comments(&task));
    Ok(read.await.map_err(todoist::Error::Worker)??)
}

/// Which tasks prompts came from, and what was written back to them.
#[tauri::command]
pub async fn todoist_links() -> Result<todoist::Links> {
    let read = tauri::async_runtime::spawn_blocking(|| todoist::read_links(&todoist::links_path()?));
    Ok(read.await.map_err(todoist::Error::Worker)??)
}

/// Records that a prompt from the Todoist task `task` went to the agent in `pane`.
#[tauri::command]
pub async fn todoist_link(task: String, title: String, pane: String, directory: Option<String>) -> Result<()> {
    let run = tauri::async_runtime::spawn_blocking(move || {
        todoist::link(&todoist::links_path()?, &task, &title, &pane, directory.as_deref())
    });
    Ok(run.await.map_err(todoist::Error::Worker)??)
}

/// Writes the ledger entry `entry` back to the task `task` its prompt came
/// from; false when that was done already.
#[tauri::command]
pub async fn todoist_write_back(task: String, entry: ledger::Entry, from: Option<String>) -> Result<bool> {
    let run = tauri::async_runtime::spawn_blocking(move || {
        todoist::write_back(&todoist::links_path()?, &task, &entry, from.as_deref())
    });
    Ok(run.await.map_err(todoist::Error::Worker)??)
}

/// How many Todoist tasks were completed between `since` and `until`.
#[tauri::command]
pub async fn todoist_completed(since: String, until: String) -> Result<usize> {
    let read = tauri::async_runtime::spawn_blocking(move || todoist::completed(&since, &until));
    Ok(read.await.map_err(todoist::Error::Worker)??)
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
        let Some(projects) = claude_projects() else {
            return vec![None; sessions.len()];
        };
        app.state::<session_usage::Cache>().read(&projects, &sessions, unix_now())
    });
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// The sessions that worked in `folders` or under them, closed ones included,
/// newest first, from this Mac's transcripts. Reads only the ends of files, and
/// holds no lock the tab header waits on.
#[tauri::command]
pub async fn recent_sessions(
    app: AppHandle,
    connection: State<'_, Connection>,
    folders: Vec<String>,
) -> Result<Vec<RecentSession>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || {
        let Some(projects) = claude_projects() else {
            return Vec::new();
        };
        let sessions = projects.with_file_name("sessions");
        app.state::<recent_sessions::Cache>().list(&projects, &sessions, &folders)
    });
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// The latest messages of a session, for the Sessions panel to show before
/// anything is resumed.
#[tauri::command]
pub async fn session_preview(connection: State<'_, Connection>, session: String) -> Result<recent_sessions::Preview> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || {
        let projects = claude_projects().ok_or_else(|| recent_sessions::Error::Unknown(session.clone()))?;
        recent_sessions::preview(&projects, &session)
    });
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// Opens a tab in `workspace_id` running `claude --resume <session>`, in the
/// folder the transcript says, unless something already has the session open.
/// Takes only the id, so the webview cannot start it anywhere else.
#[tauri::command]
pub async fn session_resume(
    app: AppHandle,
    connection: State<'_, Connection>,
    workspace_id: String,
    session: String,
) -> Result<queue::Opened> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || -> Result<queue::Opened> {
        let projects = claude_projects().ok_or_else(|| recent_sessions::Error::Unknown(session.clone()))?;
        let sessions = projects.with_file_name("sessions");
        let target = app.state::<recent_sessions::Cache>().target(&projects, &sessions, &session)?;
        Ok(queue::resume(&workspace_id, &target.folder, &target.label, &resume_name(), &session)?)
    });
    run.await.map_err(changes::Error::Worker)?
}

/// A resumed agent's name: `p`, as the prompt library's tabs. Herdr refuses a
/// name in use, and several resumes can land in one millisecond after a restart.
fn resume_name() -> String {
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis());
    let count = u128::from(COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    format!("p{}", (millis + count) % 1_000_000_000)
}

/// Saves which session each pane holds for the daemon's boot `boot_id`, and
/// returns the panes of the boot before, once, when this is a new one, for the
/// window to resume. See `open_sessions`.
#[tauri::command]
pub async fn open_sessions_sync(
    connection: State<'_, Connection>,
    boot_id: String,
    panes: Vec<open_sessions::OpenSession>,
) -> Result<Vec<open_sessions::OpenSession>> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || open_sessions::sync(&open_sessions::path()?, &boot_id, panes));
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Runs `claude --resume <session>` in the pane `pane_id`, which the daemon
/// restored without its agent, unless something already has the session open.
#[tauri::command]
pub async fn session_resume_in(
    app: AppHandle,
    connection: State<'_, Connection>,
    session: String,
    tab_id: String,
    pane_id: String,
) -> Result<queue::Opened> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || -> Result<queue::Opened> {
        let projects = claude_projects().ok_or_else(|| recent_sessions::Error::Unknown(session.clone()))?;
        let sessions = projects.with_file_name("sessions");
        let target = app.state::<recent_sessions::Cache>().target(&projects, &sessions, &session)?;
        Ok(queue::resume_in(&tab_id, &pane_id, &target.folder, &resume_name(), &session)?)
    });
    run.await.map_err(changes::Error::Worker)?
}

/// What fills each Claude Code session's context, by session id; `None` as for
/// [`session_usage`]. Reads the whole of each transcript, so the Context dialog
/// asks while it is open and not on the header's poll.
#[tauri::command]
pub async fn session_context(
    app: AppHandle,
    connection: State<'_, Connection>,
    sessions: Vec<String>,
) -> Result<Vec<Option<SessionContext>>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || {
        let Some(projects) = claude_projects() else {
            return vec![None; sessions.len()];
        };
        let cache = app.state::<session_usage::Cache>();
        sessions
            .iter()
            .map(|id| session_context::read(&cache.transcript(&projects, id)?))
            .collect()
    });
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// Image number `paste` of a Claude Code session, read from its transcript.
#[tauri::command]
pub async fn pasted_image(
    app: AppHandle,
    connection: State<'_, Connection>,
    session: String,
    paste: u64,
) -> Result<Option<PastedImage>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || {
        let transcript = app.state::<session_usage::Cache>().transcript(&claude_projects()?, &session)?;
        pasted_image::read(&transcript, paste)
    });
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// Every project's Claude token use over the last week, read from this Mac's
/// transcripts. Whichever host the window is connected to: the account is the
/// user's. The first read goes through a week of transcripts.
#[tauri::command]
pub async fn usage_history(app: AppHandle) -> Result<Vec<ProjectUsage>> {
    let read = tauri::async_runtime::spawn_blocking(move || {
        let Some(projects) = claude_projects() else {
            return Vec::new();
        };
        app.state::<session_usage::Cache>().history(&projects, unix_now())
    });
    Ok(read.await.map_err(changes::Error::Worker)?)
}

fn claude_projects() -> Option<std::path::PathBuf> {
    Some(std::path::Path::new(&std::env::var_os("HOME")?).join(".claude/projects"))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

/// Every file of the checkout `directory` sits in, the ignored ones too with
/// `ignored`, or `None` outside Git.
#[tauri::command]
pub async fn list_files(
    connection: State<'_, Connection>,
    directory: String,
    ignored: bool,
) -> Result<Option<Listing>> {
    let target = connection.target();
    let read = tauri::async_runtime::spawn_blocking(move || files::list(&target, &directory, ignored));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// One level of an ignored folder of the checkout at `root`.
#[tauri::command]
pub async fn list_folder(
    connection: State<'_, Connection>,
    root: String,
    path: String,
) -> Result<Vec<String>> {
    let target = connection.target();
    let read = tauri::async_runtime::spawn_blocking(move || files::list_folder(&target, &root, &path));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// The file a path in a pane's text names from that pane's folder.
#[tauri::command]
pub async fn find_file(
    connection: State<'_, Connection>,
    directory: String,
    name: String,
) -> Result<Option<FoundFile>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || files::find(&directory, &name));
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// One file of the checkout at `root`, for the file view.
#[tauri::command]
pub async fn read_file(
    connection: State<'_, Connection>,
    root: String,
    path: String,
) -> Result<Contents> {
    let target = connection.target();
    let read = tauri::async_runtime::spawn_blocking(move || files::read(&target, &root, &path));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// Saves the file view's text over the file, unless it no longer holds `base`.
/// Answers whether it wrote; no `base` overwrites.
#[tauri::command]
pub async fn write_file(
    connection: State<'_, Connection>,
    root: String,
    path: String,
    text: String,
    base: Option<String>,
) -> Result<bool> {
    connection.ensure_local()?;
    let write = tauri::async_runtime::spawn_blocking(move || {
        files::write(&root, &path, &text, base.as_deref())
    });
    Ok(write.await.map_err(changes::Error::Worker)??)
}

/// Moves a tab's panes into a new tab of another workspace through the
/// `herdr` CLI, on the blocking pool since it waits on child processes.
#[tauri::command]
pub async fn move_tab(
    connection: State<'_, Connection>,
    panes: Vec<String>,
    workspace_id: String,
    label: Option<String>,
) -> Result<String> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        let to = Destination::Workspace(&workspace_id);
        crate::tab_move::move_tab(&panes, to, label.as_deref())
    });
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// As `move_tab`, into a new workspace called `name`, whose id it returns.
#[tauri::command]
pub async fn move_tab_to_new_workspace(
    connection: State<'_, Connection>,
    panes: Vec<String>,
    name: String,
    label: Option<String>,
) -> Result<String> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        crate::tab_move::move_tab(&panes, Destination::New(&name), label.as_deref())
    });
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Drops the `herdr-outcome` token of these panes through the `herdr` CLI, on
/// the blocking pool since it waits on child processes.
#[tauri::command]
pub async fn clear_outcome(connection: State<'_, Connection>, panes: Vec<String>) -> Result<()> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || crate::outcome::clear(&panes));
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// The outcome ledger as it stands (`ledger.rs`). This computer's, whichever
/// host the window is attached to, as the agents that write it run here.
#[tauri::command]
pub async fn ledger_read() -> Result<ledger::Ledger> {
    let run = tauri::async_runtime::spawn_blocking(|| ledger::read(&ledger::path()?));
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Records that the ledger entry `id` was dealt with, `how`.
#[tauri::command]
pub async fn ledger_resolve(id: String, how: String) -> Result<()> {
    let run = tauri::async_runtime::spawn_blocking(move || ledger::resolve(&ledger::path()?, &id, &how));
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Writes a starter team into a workspace's folder: the team file and an
/// agent per role, keeping any agent file the repo already has.
#[tauri::command]
pub fn create_team(connection: State<'_, Connection>, directory: String) -> Result<Vec<String>> {
    connection.ensure_local()?;
    Ok(crate::team::create(&directory)?)
}

/// Writes one role's agent file from its starter, or a stub, never over one
/// that is there; returns the file's path in the folder.
#[tauri::command]
pub fn create_agent(connection: State<'_, Connection>, directory: String, agent: String) -> Result<String> {
    connection.ensure_local()?;
    Ok(crate::team::create_agent(&directory, &agent)?)
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

/// Where the prompt queue is kept: the app's own data folder, since it is
/// what the window remembers, not a setting.
fn queue_path(app: &AppHandle) -> Result<std::path::PathBuf> {
    let dir = app.path().app_data_dir().map_err(|_| queue::StoreError::NoDataDir)?;
    Ok(dir.join("queue-tauri.json"))
}

/// The prompt queue, every workspace's, as the webview last saved it, once
/// this window owns it (`queue::Owner`).
#[tauri::command]
pub fn queue_load(app: AppHandle, owner: State<'_, queue::Owner>) -> Result<Value> {
    let path = queue_path(&app)?;
    owner.claim(&path)?;
    Ok(queue::load(&path)?)
}

/// Replaces the saved prompt queue with `data`.
#[tauri::command]
pub fn queue_save(app: AppHandle, owner: State<'_, queue::Owner>, data: Value) -> Result<()> {
    owner.check()?;
    Ok(queue::save(&queue_path(&app)?, &data)?)
}

/// The inbox beside the queue file, where others leave prompts for the queue.
fn inbox_path(app: &AppHandle) -> Result<std::path::PathBuf> {
    Ok(queue_path(app)?.with_file_name("queue-inbox"))
}

/// The prompts waiting in the inbox, in the order they were sent; a file that
/// fails the checks is moved to `queue-inbox/rejected/` instead.
#[tauri::command]
pub fn queue_inbox_list(app: AppHandle, owner: State<'_, queue::Owner>) -> Result<Vec<queue::Entry>> {
    owner.check()?;
    Ok(queue::inbox(&inbox_path(&app)?)?)
}

/// Moves an inbox file whose prompt the saved queue now holds to `taken/`,
/// or, with a `reason`, to `rejected/`.
#[tauri::command]
pub fn queue_inbox_settle(
    app: AppHandle,
    owner: State<'_, queue::Owner>,
    name: String,
    reason: Option<String>,
) -> Result<()> {
    owner.check()?;
    Ok(queue::settle(&inbox_path(&app)?, &name, reason.as_deref())?)
}

/// Opens a tab for one queued prompt and starts its agent, through the
/// `herdr` CLI on the blocking pool; the prompt follows with `queue_prompt`.
#[tauri::command]
pub async fn queue_open(
    connection: State<'_, Connection>,
    workspace_id: String,
    directory: String,
    label: String,
    name: String,
    kind: String,
    args: Vec<String>,
) -> Result<queue::Opened> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        queue::open(&workspace_id, &directory, &label, &name, &kind, &args)
    });
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Runs a queued prompt's agent in a new worktree, in a workspace of its own.
#[tauri::command]
pub async fn queue_worktree(
    connection: State<'_, Connection>,
    directory: String,
    path: String,
    label: String,
    name: String,
    kind: String,
    args: Vec<String>,
) -> Result<queue::Opened> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        queue::worktree(&directory, &path, &label, &name, &kind, &args)
    });
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Submits a queued prompt to the agent `queue_open` started.
#[tauri::command]
pub async fn queue_prompt(connection: State<'_, Connection>, name: String, text: String) -> Result<()> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || queue::prompt(&name, &text));
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// The prompt library's files: `~/.claude/commands/` and, given the focused
/// workspace's folder, its `.claude/commands/`. This Mac only.
#[tauri::command]
pub async fn prompt_library(connection: State<'_, Connection>, directory: Option<String>) -> Result<prompts::Library> {
    connection.ensure_local()?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let run = tauri::async_runtime::spawn_blocking(move || prompts::library(home.as_deref(), directory.as_deref()));
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// Writes a new prompt `<name>.md` into `directory`'s `.claude/commands/`, or
/// the global folder without one. Never over a file. This Mac only.
#[tauri::command]
pub async fn prompt_create(connection: State<'_, Connection>, directory: Option<String>, name: String, text: String) -> Result<()> {
    connection.ensure_local()?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let run = tauri::async_runtime::spawn_blocking(move || prompts::create(home.as_deref(), directory.as_deref(), &name, &text));
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Replaces the prompt at `path` in `directory`'s `.claude/commands/`, or the
/// global folder without one, if it still holds `expected`. This Mac only.
#[tauri::command]
pub async fn prompt_save(
    connection: State<'_, Connection>,
    directory: Option<String>,
    path: String,
    expected: String,
    text: String,
) -> Result<()> {
    connection.ensure_local()?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let run = tauri::async_runtime::spawn_blocking(move || prompts::save(home.as_deref(), directory.as_deref(), &path, &expected, &text));
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// Submits a prompt from the library to the agent in the pane `pane`.
#[tauri::command]
pub async fn prompt_send(connection: State<'_, Connection>, pane: String, text: String) -> Result<()> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || queue::send(&pane, &text));
    Ok(run.await.map_err(changes::Error::Worker)??)
}

/// The folder a queue for each directory is kept on: see `queue::home`.
#[tauri::command]
pub async fn queue_homes(connection: State<'_, Connection>, directories: Vec<String>) -> Result<Vec<Option<String>>> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || {
        directories.iter().map(|directory| queue::home(directory)).collect()
    });
    Ok(run.await.map_err(changes::Error::Worker)?)
}

/// How many commits a queued prompt left in its checkout since `since`.
#[tauri::command]
pub async fn queue_commits(connection: State<'_, Connection>, directory: String, since: String) -> Result<u32> {
    connection.ensure_local()?;
    let run = tauri::async_runtime::spawn_blocking(move || queue::commits(&directory, &since));
    Ok(run.await.map_err(changes::Error::Worker)?.map_err(changes::Error::Git)?)
}

/// The `count` commits a queued prompt left in its checkout after `since`.
#[tauri::command]
pub async fn queue_log(
    connection: State<'_, Connection>,
    directory: String,
    since: String,
    count: usize,
) -> Result<Vec<CommitView>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || changes::read_commits_after(&directory, &since, count));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// Opens a workspace's folder in the file manager or one of a few known apps.
#[tauri::command]
pub fn open_folder(connection: State<'_, Connection>, path: String, with: Opener) -> Result<()> {
    connection.ensure_local()?;
    Ok(folder::open(&path, with)?)
}

/// Opens one file of a workspace's folder in VS Code, refusing any path that leaves it.
#[tauri::command]
pub fn open_file(connection: State<'_, Connection>, root: String, path: String) -> Result<()> {
    connection.ensure_local()?;
    Ok(folder::open_file(&root, &path)?)
}

/// The full path of a file or folder a terminal link names, in a checkout or not.
#[tauri::command]
pub async fn locate_file(
    connection: State<'_, Connection>,
    directory: String,
    name: String,
) -> Result<Option<files::Located>> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || files::locate(&directory, &name));
    Ok(read.await.map_err(changes::Error::Worker)?)
}

/// An image a terminal link names outside any checkout, by its full path.
#[tauri::command]
pub async fn read_link_image(connection: State<'_, Connection>, path: String) -> Result<Contents> {
    connection.ensure_local()?;
    let read = tauri::async_runtime::spawn_blocking(move || files::read_image(&path));
    Ok(read.await.map_err(changes::Error::Worker)??)
}

/// Opens, reveals or edits a file a terminal link names, wherever it is.
#[tauri::command]
pub fn open_link_file(connection: State<'_, Connection>, path: String, with: FileAction) -> Result<()> {
    connection.ensure_local()?;
    Ok(folder::open_link_file(&path, with)?)
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

/// The settings file as JSON. Settings and themes are this Mac's, whichever
/// host the window is attached to.
#[tauri::command]
pub fn settings_load() -> Result<settings::Loaded> {
    Ok(settings::load_from(&settings::path()?)?)
}

/// Sets one key of the settings file (null removes it), keeping its comments.
#[tauri::command]
pub fn settings_set(key: String, value: Value) -> Result<()> {
    Ok(settings::set_in(&settings::path()?, &key, &value)?)
}

/// Sets one entry of a table keyed by the user's own names, such as folders
/// (null removes it), keeping the file's comments.
#[tauri::command]
pub fn settings_set_entry(table: String, entry: String, value: Value) -> Result<()> {
    Ok(settings::set_entry_in(
        &settings::path()?,
        &table,
        &entry,
        &value,
    )?)
}

/// Every Ghostty theme installed on this Mac, by file name.
#[tauri::command]
pub async fn theme_list() -> Result<Vec<String>> {
    let list = tauri::async_runtime::spawn_blocking(|| settings::list_in(&settings::theme_directories()));
    Ok(list.await.map_err(settings::Error::Worker)?)
}

/// One theme file's text, from a theme folder or the path the settings file names.
#[tauri::command]
pub async fn theme_read(name: String) -> Result<String> {
    let read = tauri::async_runtime::spawn_blocking(move || settings::read_theme(&name));
    Ok(read.await.map_err(settings::Error::Worker)??)
}

//! The Rust half of Herdr Tauri: a thin bridge from the webview to
//! `herdr-client`. Everything the user sees is TypeScript in `src/`; this side
//! owns the socket and the wire format and exposes them as Tauri commands.

mod changes;
mod claude_usage;
mod commands;
mod connection;
mod error;
mod files;
mod folder;
mod frame;
mod git;
mod herdr;
mod land;
mod listening_ports;
#[cfg(target_os = "macos")]
mod menu;
mod osc52;
mod process;
mod prompts;
mod queue;
mod session_usage;
mod settings;
mod ssh_hosts;
mod sync;
mod tab_move;
mod team;
mod worktree_ops;
mod worktrees;

pub use error::{Error, Result};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(claude_usage::Cache::default())
        .manage(connection::Connection::default())
        .manage(queue::Owner::default())
        .manage(session_usage::Cache::default())
        .manage(ssh_hosts::PendingKeys::default())
        .manage(sync::Running::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);
    let result = builder
        .invoke_handler(tauri::generate_handler![
            // keep-sorted start
            commands::change_counts,
            commands::checkout_changes,
            commands::claude_usage,
            commands::connect,
            commands::copy_path,
            commands::create_agent,
            commands::create_team,
            commands::discard_file,
            commands::discard_plan,
            commands::disconnect,
            commands::commit_files,
            commands::commit_paths,
            commands::moving_commits,
            commands::sync_checkout,
            commands::land_plan,
            commands::land_check,
            commands::land_finish,
            commands::file_diff,
            commands::listening_ports,
            commands::list_files,
            commands::move_tab,
            commands::open_file,
            commands::open_folder,
            commands::prompt_create,
            commands::prompt_save,
            commands::prompt_library,
            commands::prompt_send,
            commands::queue_commits,
            commands::queue_log,
            commands::queue_homes,
            commands::queue_inbox_list,
            commands::queue_inbox_settle,
            commands::queue_load,
            commands::queue_open,
            commands::queue_worktree,
            commands::queue_prompt,
            commands::queue_save,
            commands::read_file,
            commands::request,
            commands::resize,
            commands::send_input,
            commands::send_popup_input,
            commands::session_usage,
            commands::usage_history,
            commands::settings_load,
            commands::settings_set,
            commands::scan_host_key,
            commands::set_focus,
            commands::ssh_hosts,
            commands::start_team,
            commands::theme_list,
            commands::theme_read,
            commands::trust_host_key,
            commands::worktrees,
            // keep-sorted end
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("herdr-tauri: {error}");
        std::process::exit(1);
    }
}

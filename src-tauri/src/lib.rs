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
mod listening_ports;
mod osc52;
mod process;
mod session_usage;
mod ssh_hosts;
mod tab_move;
mod worktrees;

pub use error::{Error, Result};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(claude_usage::Cache::default())
        .manage(connection::Connection::default())
        .manage(session_usage::Cache::default())
        .manage(ssh_hosts::PendingKeys::default())
        .invoke_handler(tauri::generate_handler![
            // keep-sorted start
            commands::change_counts,
            commands::checkout_changes,
            commands::claude_usage,
            commands::connect,
            commands::copy_path,
            commands::disconnect,
            commands::commit_files,
            commands::file_diff,
            commands::listening_ports,
            commands::list_files,
            commands::move_tab,
            commands::open_folder,
            commands::read_file,
            commands::request,
            commands::resize,
            commands::send_input,
            commands::send_popup_input,
            commands::session_usage,
            commands::scan_host_key,
            commands::set_focus,
            commands::ssh_hosts,
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

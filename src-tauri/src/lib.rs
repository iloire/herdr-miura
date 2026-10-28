//! The Rust half of Herdr Tauri: a thin bridge from the webview to
//! `herdr-client`. Everything the user sees is TypeScript in `src/`; this side
//! owns the socket and the wire format and exposes them as Tauri commands.

mod changes;
mod commands;
mod connection;
mod error;
mod frame;
mod osc52;

pub use error::{Error, Result};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(connection::Connection::default())
        .invoke_handler(tauri::generate_handler![
            // keep-sorted start
            commands::catalog,
            commands::checkout_changes,
            commands::connect,
            commands::disconnect,
            commands::file_diff,
            commands::request,
            commands::resize,
            commands::run_command,
            commands::send_input,
            commands::send_popup_input,
            commands::set_focus,
            // keep-sorted end
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("herdr-tauri: {error}");
        std::process::exit(1);
    }
}

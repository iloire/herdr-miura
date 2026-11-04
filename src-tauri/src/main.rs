// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer kills the window on Wayland with NVIDIA's
    // driver ("Error 71 (Protocol error) dispatching to Wayland display").
    // Set before any thread starts; an explicit value in the env still wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: single-threaded here, nothing else reads the environment yet.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    herdr_miura_lib::run()
}

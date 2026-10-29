//! The macOS app menu: Tauri's default one (About, Services, Hide, Quit, the
//! Edit menu the terminal and text fields copy and paste through) with a
//! Settings… item under About. Linux and Windows have no app menu.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Runtime};

const SETTINGS_ID: &str = "open_settings";

/// The event a click on Settings… sends the webview, which runs the catalog's
/// `open_settings` command.
const SETTINGS_EVENT: &str = "menu://open_settings";

/// The default menu with Settings… after About. The item owns ⌘, so the
/// webview leaves that key to it on macOS.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
        let settings = MenuItem::with_id(app, SETTINGS_ID, "Settings…", true, Some("Cmd+,"))?;
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        app_menu.insert(&settings, 2)?;
    }
    Ok(menu)
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == SETTINGS_ID {
        let _ = app.emit(SETTINGS_EVENT, ());
    }
}

//! The macOS app menu: Tauri's default one (About, Services, Hide, Quit, the
//! Edit menu the terminal and text fields copy and paste through) with a
//! Settings… item under About and Reopen Closed Session in File. Linux and
//! Windows have no app menu.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Runtime};

const SETTINGS_ID: &str = "open_settings";
const REOPEN_ID: &str = "reopen_closed_session";

/// The event a click on Settings… sends the webview, which runs the catalog's
/// `open_settings` command.
const SETTINGS_EVENT: &str = "menu://open_settings";

/// The same for Reopen Closed Session, and the catalog's command of that name.
const REOPEN_EVENT: &str = "menu://reopen_closed_session";

/// The default menu with Settings… after About and Reopen Closed Session at the
/// top of File. Each item owns its key, so the webview leaves those to it on macOS.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
        let settings = MenuItem::with_id(app, SETTINGS_ID, "Settings…", true, Some("Cmd+,"))?;
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        app_menu.insert(&settings, 2)?;
    }
    let file = menu.items()?.into_iter().filter_map(|item| item.as_submenu().cloned()).find(|menu| menu.text().is_ok_and(|text| text == "File"));
    if let Some(file) = file {
        file.prepend(&MenuItem::with_id(app, REOPEN_ID, "Reopen Closed Session", true, Some("Cmd+Shift+R"))?)?;
    }
    Ok(menu)
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == SETTINGS_ID {
        let _ = app.emit(SETTINGS_EVENT, ());
    } else if event.id() == REOPEN_ID {
        let _ = app.emit(REOPEN_EVENT, ());
    }
}

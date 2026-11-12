//! Child processes this app starts. On Windows a console child would open a
//! window of its own, so every command is built here with that suppressed.

use std::{
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

/// Where a GUI app opened from the Dock may not look, as herdr-gpui's host
/// scripts add them.
const EXTRA_DIRS: &[&str] = &[
    ".local/bin",
    ".local/share/mise/shims",
    ".bun/bin",
    ".cargo/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ".nix-profile/bin",
];

/// The program `name` on `PATH`, or in one of the places a CLI is usually
/// installed that a Dock-launched app's `PATH` leaves out.
pub fn find(name: &str) -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let path = env::var_os("PATH").unwrap_or_default();
    env::split_paths(&path)
        .chain(EXTRA_DIRS.iter().map(|dir| {
            if Path::new(dir).is_absolute() {
                PathBuf::from(dir)
            } else {
                home.join(dir)
            }
        }))
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

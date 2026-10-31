//! The settings file, `~/.config/herdr/config-tauri.toml`, and the Ghostty
//! theme files a `theme` value can name. Rust owns the file: it reads it as
//! JSON for the webview, which decides what each key means, and writes one key
//! at a time with `toml_edit`, so comments and hand edits survive. A theme is
//! read only from a theme folder, or from the one path the file names.

use serde::Serialize;
use serde_json::{Map, Number, Value};
use std::{
    env, fs,
    io::{ErrorKind, Read},
    path::{Component, Path, PathBuf},
};
use toml_edit::{DocumentMut, Item, Table};

/// A settings file bigger than this is not one anyone wrote by hand.
const MAX_SETTINGS_BYTES: u64 = 1 << 20;
/// Ghostty theme files are under 1 KiB; this leaves room for comments.
const MAX_THEME_BYTES: u64 = 64 << 10;
/// A string setting's bytes at most (a font list, a command).
const MAX_VALUE_BYTES: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("HOME is not set, so there is no settings file")]
    NoHome,
    #[error("could not read {path}")]
    Read {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("could not write {path}")]
    Write {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{0} is too large to be a settings or theme file")]
    TooLarge(String),
    #[error("{path} does not parse, so it is left as it is: {message}")]
    Unparsable { path: String, message: String },
    #[error("`{0}` is not a settings key")]
    BadKey(String),
    #[error("{0} is not a value a setting can hold")]
    BadValue(String),
    #[error("`{0}` is not a table in the settings file")]
    NotTable(String),
    #[error("no theme named {0} in the theme folders")]
    ThemeNotFound(String),
    #[error("{0} is not the theme the settings file names")]
    NotNamed(String),
    #[error("the theme reader stopped")]
    Worker(#[source] tauri::Error),
}

/// What `settings_load` hands the webview.
#[derive(Debug, Serialize)]
pub struct Loaded {
    path: String,
    /// The file as JSON: `{}` when it is missing or does not parse.
    values: Value,
    /// Why the file did not parse, for the warning strip.
    error: Option<String>,
}

fn home() -> Result<PathBuf, Error> {
    env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or(Error::NoHome)
}

/// Herdr's config folder: `$XDG_CONFIG_HOME` when absolute, else `~/.config`.
fn config_root() -> Result<PathBuf, Error> {
    match env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
        Some(root) if root.is_absolute() => Ok(root),
        _ => Ok(home()?.join(".config")),
    }
}

/// `~/.config/herdr/config-tauri.toml`, beside Herdr's and herdr-gpui's own.
pub fn path() -> Result<PathBuf, Error> {
    Ok(config_root()?.join("herdr/config-tauri.toml"))
}

/// The file's text, or `None` when there is none.
fn read_capped(path: &Path, cap: u64) -> Result<Option<String>, Error> {
    let shown = || path.display().to_string();
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(Error::Read {
                path: shown(),
                source,
            });
        }
    };
    let mut text = String::new();
    file.take(cap + 1)
        .read_to_string(&mut text)
        .map_err(|source| Error::Read {
            path: shown(),
            source,
        })?;
    if text.len() as u64 > cap {
        return Err(Error::TooLarge(shown()));
    }
    Ok(Some(text))
}

fn json(item: &toml_edit::Value) -> Value {
    use toml_edit::Value as T;
    match item {
        T::String(s) => Value::String(s.value().clone()),
        T::Integer(i) => Value::Number((*i.value()).into()),
        T::Float(f) => Number::from_f64(*f.value()).map_or(Value::Null, Value::Number),
        T::Boolean(b) => Value::Bool(*b.value()),
        T::Datetime(d) => Value::String(d.value().to_string()),
        T::Array(array) => Value::Array(array.iter().map(json).collect()),
        T::InlineTable(table) => Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.to_owned(), json(value)))
                .collect(),
        ),
    }
}

fn table_json(table: &Table) -> Value {
    let mut object = Map::new();
    for (key, item) in table.iter() {
        let value = match item {
            Item::Value(value) => json(value),
            Item::Table(table) => table_json(table),
            Item::ArrayOfTables(array) => Value::Array(array.iter().map(table_json).collect()),
            Item::None => continue,
        };
        object.insert(key.to_owned(), value);
    }
    Value::Object(object)
}

/// The settings at `path`. A missing file is empty; one that does not parse
/// is empty too, with the reason, so the window still opens on defaults.
pub fn load_from(path: &Path) -> Result<Loaded, Error> {
    let text = read_capped(path, MAX_SETTINGS_BYTES)?.unwrap_or_default();
    let (values, error) = match text.parse::<DocumentMut>() {
        Ok(document) => (table_json(document.as_table()), None),
        Err(error) => (Value::Object(Map::new()), Some(error.to_string())),
    };
    Ok(Loaded {
        path: path.display().to_string(),
        values,
        error,
    })
}

/// `key` split at its dots: one or two parts of lowercase words, as every
/// setting is named (`theme`, `terminal.font_size`).
fn key_parts(key: &str) -> Result<Vec<&str>, Error> {
    let parts: Vec<&str> = key.split('.').collect();
    let word = |part: &&str| {
        !part.is_empty()
            && part.len() <= 64
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    };
    if parts.len() > 2 || !parts.iter().all(word) {
        return Err(Error::BadKey(key.into()));
    }
    Ok(parts)
}

/// `value` as TOML: a string, number or boolean. `None` is null, which removes the key.
fn toml_value(value: &Value) -> Result<Option<toml_edit::Value>, Error> {
    let bad = || Error::BadValue(value.to_string());
    Ok(Some(match value {
        Value::Null => return Ok(None),
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.into(),
            None => n.as_f64().filter(|f| f.is_finite()).ok_or_else(bad)?.into(),
        },
        Value::String(s) if s.len() <= MAX_VALUE_BYTES && !s.chars().any(char::is_control) => {
            s.as_str().into()
        }
        _ => return Err(bad()),
    }))
}

/// Sets `key` to `value` in the file at `path` (null removes it), changing
/// nothing else in it. A file that does not parse is refused rather than
/// rewritten. A symlinked file is written through its link, so a provisioned
/// file stays a link into the dotfiles.
pub fn set_in(path: &Path, key: &str, value: &Value) -> Result<(), Error> {
    set_parts(path, &key_parts(key)?, value)
}

/// Sets `entry` of a table whose keys are the user's rather than setting names,
/// as `workspace_colors` is keyed by folder: any one line of text, which TOML
/// quotes. `table` is a plain top-level key. Otherwise as `set_in`.
pub fn set_entry_in(path: &Path, table: &str, entry: &str, value: &Value) -> Result<(), Error> {
    let parts = key_parts(table)?;
    let [table] = parts.as_slice() else {
        return Err(Error::BadKey(table.into()));
    };
    if entry.is_empty() || entry.len() > MAX_VALUE_BYTES || entry.chars().any(char::is_control) {
        return Err(Error::BadKey(entry.into()));
    }
    set_parts(path, &[table, entry], value)
}

fn set_parts(path: &Path, parts: &[&str], value: &Value) -> Result<(), Error> {
    let new = toml_value(value)?;
    let target = if path.is_symlink() {
        fs::canonicalize(path).map_err(|source| Error::Read {
            path: path.display().to_string(),
            source,
        })?
    } else {
        path.to_owned()
    };
    let text = read_capped(&target, MAX_SETTINGS_BYTES)?.unwrap_or_default();
    let mut document = text
        .parse::<DocumentMut>()
        .map_err(|error| Error::Unparsable {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
    let (last, tables) = parts
        .split_last()
        .ok_or_else(|| Error::BadKey(parts.join(".")))?;
    // A file of comments alone (as provisioned, every key commented out) holds
    // them as trailing text, which prints after everything: whatever is added
    // at the end takes them as its prefix, so it lands below them, not above.
    let mut trailing = document.trailing().as_str().unwrap_or_default().to_owned();
    let last_table = document
        .as_table()
        .iter()
        .filter_map(|(name, item)| {
            item.as_table()
                .map(|table| (table.position(), name.to_owned()))
        })
        .max()
        .map(|(_, name)| name);
    let mut at_end = tables.first().map_or(last_table.is_none(), |name| {
        last_table.as_deref() == Some(*name)
    });
    let mut table = document.as_table_mut();
    for part in tables {
        if !table.contains_key(part) {
            if new.is_none() {
                return Ok(());
            }
            let mut created = Table::new();
            let mut prefix = std::mem::take(&mut trailing);
            // A blank line before the header, as a hand-written file has.
            if prefix.is_empty() && !table.is_empty() {
                prefix.push('\n');
            }
            created.decor_mut().set_prefix(prefix);
            table.insert(part, Item::Table(created));
            at_end = false;
        }
        table = table
            .get_mut(part)
            .and_then(Item::as_table_mut)
            .ok_or_else(|| Error::NotTable((*part).into()))?;
    }
    match (new, table.get_mut(last)) {
        (None, None) => return Ok(()),
        (None, Some(_)) => {
            // The key's own leading comments stay: on the key after it, or at the end.
            let prefix = table
                .key_mut(last)
                .and_then(|mut key| {
                    key.leaf_decor_mut()
                        .prefix()
                        .and_then(|p| p.as_str())
                        .map(str::to_owned)
                })
                .filter(|prefix| prefix.contains('#'));
            table.remove(last);
            if let Some(prefix) = prefix {
                let next = table.iter().map(|(name, _)| name.to_owned()).next();
                match next.and_then(|name| table.key_mut(&name)) {
                    Some(mut key) => {
                        let old = key
                            .leaf_decor_mut()
                            .prefix()
                            .and_then(|p| p.as_str())
                            .unwrap_or_default()
                            .to_owned();
                        key.leaf_decor_mut().set_prefix(prefix + &old);
                    }
                    None => trailing = prefix + &trailing,
                }
            }
        }
        // Keep the comment beside the old value, and its spacing.
        (Some(mut new), Some(Item::Value(old))) => {
            *new.decor_mut() = old.decor().clone();
            *old = new;
        }
        (Some(new), _) => {
            table.insert(last, Item::Value(new));
            if at_end && let Some(mut key) = table.key_mut(last) {
                key.leaf_decor_mut()
                    .set_prefix(std::mem::take(&mut trailing));
            }
        }
    }
    document.set_trailing(trailing);
    write(&target, &document.to_string())
}

/// Writes through a temporary file beside `path` and renames it over, so a
/// reader never sees half a file.
fn write(path: &Path, text: &str) -> Result<(), Error> {
    let error = |source| Error::Write {
        path: path.display().to_string(),
        source,
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error)?;
    }
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".tmp-{}", std::process::id()));
    let temporary = PathBuf::from(temporary);
    fs::write(&temporary, text).map_err(error)?;
    fs::rename(&temporary, path).map_err(|source| {
        let _ = fs::remove_file(&temporary);
        error(source)
    })
}

/// Where Ghostty themes live, in herdr-gpui's order: Herdr's and Ghostty's
/// config folders, Ghostty's resources, the app bundle, then XDG data folders.
pub fn theme_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Ok(root) = config_root() {
        directories.extend([root.join("herdr/themes"), root.join("ghostty/themes")]);
    }
    if let Some(resources) = env::var_os("GHOSTTY_RESOURCES_DIR").filter(|value| !value.is_empty())
    {
        directories.push(PathBuf::from(resources).join("themes"));
    }
    directories.push(PathBuf::from(
        "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
    ));
    match env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        Some(data) => directories.push(PathBuf::from(data).join("ghostty/themes")),
        None => directories.extend(
            home()
                .ok()
                .map(|home| home.join(".local/share/ghostty/themes")),
        ),
    }
    match env::var_os("XDG_DATA_DIRS").filter(|value| !value.is_empty()) {
        Some(dirs) => {
            directories.extend(env::split_paths(&dirs).map(|dir| dir.join("ghostty/themes")))
        }
        None => directories.extend(
            ["/usr/local/share", "/usr/share"].map(|dir| Path::new(dir).join("ghostty/themes")),
        ),
    }
    directories
}

/// Every theme file's name in `directories`, sorted, each once. Folders that
/// do not exist are skipped.
pub fn list_in(directories: &[PathBuf]) -> Vec<String> {
    let mut names: Vec<String> = directories
        .iter()
        .filter_map(|directory| fs::read_dir(directory).ok())
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| fs::metadata(entry.path()).is_ok_and(|metadata| metadata.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
    names.dedup();
    names
}

/// The paths (`~/…` or absolute) a `theme` value names on either side of a
/// `light:…,dark:…` pair.
fn named_paths(theme: &str) -> Vec<&str> {
    theme
        .split(',')
        .map(|side| {
            let side = side.trim();
            side.strip_prefix("light:")
                .or_else(|| side.strip_prefix("dark:"))
                .unwrap_or(side)
                .trim()
        })
        .filter(|side| side.starts_with("~/") || side.starts_with('/'))
        .collect()
}

/// The text of the theme `name`: a file name looked up in `directories`, the
/// first holding it, and refused when it resolves outside that folder; or a
/// `~/` or absolute path, read only when `theme`, the settings file's value,
/// names it.
pub fn read_theme_in(
    name: &str,
    directories: &[PathBuf],
    theme: Option<&str>,
) -> Result<String, Error> {
    let not_found = || Error::ThemeNotFound(name.into());
    if name.starts_with("~/") || name.starts_with('/') {
        if !theme.is_some_and(|theme| named_paths(theme).contains(&name)) {
            return Err(Error::NotNamed(name.into()));
        }
        let path = match name.strip_prefix("~/") {
            Some(relative) => home()?.join(relative),
            None => PathBuf::from(name),
        };
        if !path.is_file() {
            return Err(not_found());
        }
        return read_capped(&path, MAX_THEME_BYTES)?.ok_or_else(not_found);
    }
    let mut components = Path::new(name).components();
    if !matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    ) {
        return Err(not_found());
    }
    for directory in directories {
        let candidate = directory.join(name);
        if !candidate.is_file() {
            continue;
        }
        // A link out of the folder is not a theme of that folder.
        let (Ok(file), Ok(folder)) = (fs::canonicalize(&candidate), fs::canonicalize(directory))
        else {
            continue;
        };
        if !file.starts_with(&folder) {
            return Err(not_found());
        }
        return read_capped(&file, MAX_THEME_BYTES)?.ok_or_else(not_found);
    }
    Err(not_found())
}

/// The theme `name`, checked against the settings file's own `theme` value.
pub fn read_theme(name: &str) -> Result<String, Error> {
    let loaded = load_from(&path()?)?;
    let theme = loaded.values.get("theme").and_then(Value::as_str);
    read_theme_in(name, &theme_directories(), theme)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"))
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_else(|error| panic!("{error}"))
    }

    fn put(path: &Path, text: &str) {
        fs::write(path, text).unwrap_or_else(|error| panic!("{error}"));
    }

    #[test]
    fn a_missing_file_loads_empty() {
        let dir = temp();
        let loaded = load_from(&dir.path().join("config-tauri.toml"))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(loaded.values, json!({}));
        assert!(loaded.error.is_none());
    }

    #[test]
    fn a_file_loads_as_json_and_a_broken_one_loads_empty_with_the_reason() {
        let dir = temp();
        let path = dir.path().join("config-tauri.toml");
        put(
            &path,
            "theme = \"Nord\"\nconfirm_close_tab = true\n[terminal]\nfont_size = 14\nline_height = 1.5\n",
        );
        let loaded = load_from(&path).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            loaded.values,
            json!({"theme": "Nord", "confirm_close_tab": true, "terminal": {"font_size": 14, "line_height": 1.5}})
        );
        put(&path, "theme = \n");
        let loaded = load_from(&path).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(loaded.values, json!({}));
        assert!(loaded.error.is_some());
    }

    #[test]
    fn setting_a_key_keeps_every_comment_and_the_rest_of_the_file() {
        let dir = temp();
        let path = dir.path().join("config-tauri.toml");
        let original = "# Herdr Miura settings\ntheme = \"Nord\" # the dark one\n\n[terminal]\n# Points.\nfont_size = 13\n# line_height = 1.4\n";
        put(&path, original);
        set_in(&path, "terminal.font_size", &json!(15)).unwrap_or_else(|error| panic!("{error}"));
        set_in(
            &path,
            "theme",
            &json!("light:GitHub Light Default,dark:Herdr Night"),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            read(&path),
            "# Herdr Miura settings\ntheme = \"light:GitHub Light Default,dark:Herdr Night\" # the dark one\n\n[terminal]\n# Points.\nfont_size = 15\n# line_height = 1.4\n"
        );
    }

    #[test]
    fn setting_creates_the_file_and_tables_and_null_removes_a_key() {
        let dir = temp();
        let path = dir.path().join("herdr/config-tauri.toml");
        set_in(&path, "new_tab.command", &json!("claude"))
            .unwrap_or_else(|error| panic!("{error}"));
        set_in(&path, "confirm_close_tab", &json!(true)).unwrap_or_else(|error| panic!("{error}"));
        let loaded = load_from(&path).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            loaded.values,
            json!({"confirm_close_tab": true, "new_tab": {"command": "claude"}})
        );
        set_in(&path, "new_tab.command", &Value::Null).unwrap_or_else(|error| panic!("{error}"));
        set_in(&path, "terminal.font_size", &Value::Null).unwrap_or_else(|error| panic!("{error}"));
        let loaded = load_from(&path).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            loaded.values,
            json!({"confirm_close_tab": true, "new_tab": {}})
        );
    }

    #[test]
    fn keys_added_to_a_file_of_comments_land_below_them_and_keep_them_when_removed() {
        let dir = temp();
        let path = dir.path().join("config-tauri.toml");
        put(&path, "# Herdr Miura\n# theme = \"Herdr Night\"\n");
        set_in(&path, "theme", &json!("Nord")).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            read(&path),
            "# Herdr Miura\n# theme = \"Herdr Night\"\ntheme = \"Nord\"\n"
        );
        set_in(&path, "terminal.font_size", &json!(14)).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            read(&path),
            "# Herdr Miura\n# theme = \"Herdr Night\"\ntheme = \"Nord\"\n\n[terminal]\nfont_size = 14\n"
        );
        set_in(&path, "theme", &Value::Null).unwrap_or_else(|error| panic!("{error}"));
        set_in(&path, "terminal.font_size", &Value::Null).unwrap_or_else(|error| panic!("{error}"));
        assert!(
            read(&path).starts_with("# Herdr Miura\n# theme = \"Herdr Night\"\n"),
            "{}",
            read(&path)
        );
    }

    #[test]
    fn bad_keys_values_and_broken_files_are_refused_and_left_alone() {
        let dir = temp();
        let path = dir.path().join("config-tauri.toml");
        for key in ["", "a.b.c", "Theme", "../x", "a..b", "a b"] {
            assert!(
                matches!(set_in(&path, key, &json!(1)), Err(Error::BadKey(_))),
                "{key}"
            );
        }
        for value in [
            json!([1]),
            json!({"a": 1}),
            json!("line\nbreak"),
            json!("x".repeat(5000)),
        ] {
            assert!(
                matches!(set_in(&path, "theme", &value), Err(Error::BadValue(_))),
                "{value}"
            );
        }
        assert!(!path.exists());
        put(&path, "theme = \"Nord\"\n");
        assert!(matches!(
            set_in(&path, "theme.x", &json!(1)),
            Err(Error::NotTable(_))
        ));
        put(&path, "theme = [\n");
        assert!(matches!(
            set_in(&path, "theme", &json!("Nord")),
            Err(Error::Unparsable { .. })
        ));
        assert_eq!(read(&path), "theme = [\n");
    }

    #[test]
    fn a_table_keyed_by_paths_round_trips_and_keeps_the_file() {
        let dir = temp();
        let path = dir.path().join("config-tauri.toml");
        put(&path, "# Herdr\ntheme = \"Nord\"\n");
        let (dotted, odd) = ("/Users/me/code/my.app", "/tmp/it's a \"folder\"");
        for (folder, slot) in [(dotted, "red"), (odd, "cyan")] {
            set_entry_in(&path, "workspace_colors", folder, &json!(slot))
                .unwrap_or_else(|error| panic!("{error}"));
        }
        let loaded = load_from(&path).unwrap_or_else(|error| panic!("{error}"));
        assert!(loaded.error.is_none());
        assert_eq!(
            loaded.values,
            json!({"theme": "Nord", "workspace_colors": {dotted: "red", odd: "cyan"}})
        );
        assert!(read(&path).starts_with("# Herdr\ntheme = \"Nord\"\n\n[workspace_colors]\n"));
        set_entry_in(&path, "workspace_colors", dotted, &json!("blue"))
            .unwrap_or_else(|error| panic!("{error}"));
        set_entry_in(&path, "workspace_colors", odd, &Value::Null)
            .unwrap_or_else(|error| panic!("{error}"));
        let loaded = load_from(&path).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            loaded.values,
            json!({"theme": "Nord", "workspace_colors": {dotted: "blue"}})
        );
    }

    #[test]
    fn a_keyed_table_refuses_bad_names_and_leaves_the_file() {
        let dir = temp();
        let path = dir.path().join("config-tauri.toml");
        let long = "x".repeat(5000);
        for entry in ["", "line\nbreak", long.as_str()] {
            assert!(
                matches!(
                    set_entry_in(&path, "workspace_colors", entry, &json!("red")),
                    Err(Error::BadKey(_))
                ),
                "{entry}"
            );
        }
        for table in ["", "a.b", "Colors", "../x"] {
            assert!(
                matches!(
                    set_entry_in(&path, table, "/a", &json!("red")),
                    Err(Error::BadKey(_))
                ),
                "{table}"
            );
        }
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_file_is_written_through_its_link() {
        let dir = temp();
        let dotfiles = dir.path().join("dotfiles.toml");
        let link = dir.path().join("config-tauri.toml");
        put(&dotfiles, "# provisioned\n");
        std::os::unix::fs::symlink(&dotfiles, &link).unwrap_or_else(|error| panic!("{error}"));
        set_in(&link, "theme", &json!("Nord")).unwrap_or_else(|error| panic!("{error}"));
        assert!(link.is_symlink());
        assert_eq!(read(&dotfiles), "# provisioned\ntheme = \"Nord\"\n");
    }

    #[test]
    fn themes_are_listed_once_from_every_folder() {
        let (a, b) = (temp(), temp());
        put(&a.path().join("Nord"), "");
        put(&b.path().join("Nord"), "");
        put(&b.path().join("Dracula"), "");
        put(&b.path().join(".hidden"), "");
        fs::create_dir(b.path().join("folder")).unwrap_or_else(|error| panic!("{error}"));
        let folders = [
            a.path().to_owned(),
            b.path().join("missing"),
            b.path().to_owned(),
        ];
        assert_eq!(list_in(&folders), ["Dracula", "Nord"]);
    }

    #[test]
    fn a_theme_is_read_only_from_its_folders_or_the_path_the_file_names() {
        let (folder, outside) = (temp(), temp());
        put(&folder.path().join("Nord"), "background = #2e3440\n");
        let secret = outside.path().join("secret");
        put(&secret, "background = #000000\n");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, folder.path().join("Link"))
            .unwrap_or_else(|error| panic!("{error}"));
        let folders = [folder.path().to_owned()];
        let read = |name: &str, theme: Option<&str>| read_theme_in(name, &folders, theme);
        assert_eq!(
            read("Nord", None).unwrap_or_default(),
            "background = #2e3440\n"
        );
        for refused in ["Missing", "../Nord", "sub/Nord", "", ".", "Link"] {
            assert!(
                matches!(read(refused, None), Err(Error::ThemeNotFound(_))),
                "{refused}"
            );
        }
        let path = secret.to_string_lossy().into_owned();
        assert!(matches!(read(&path, None), Err(Error::NotNamed(_))));
        assert!(matches!(read(&path, Some("Nord")), Err(Error::NotNamed(_))));
        assert!(matches!(
            read("/etc/hosts", Some(&path)),
            Err(Error::NotNamed(_))
        ));
        assert_eq!(
            read(&path, Some(&path)).unwrap_or_default(),
            "background = #000000\n"
        );
        let pair = format!("light: {path} ,dark:Nord");
        assert_eq!(
            read(&path, Some(&pair)).unwrap_or_default(),
            "background = #000000\n"
        );
    }
}

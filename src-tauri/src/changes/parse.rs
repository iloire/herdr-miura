//! Git's machine-readable output, parsed: `status --porcelain=v2 --branch -z`,
//! `diff --numstat -z`, and `log -z` with fields split by 0x1f.

/// What `git status --short` would mark a file with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Added,
    Conflicted,
    Deleted,
    Modified,
    Renamed,
    Untracked,
}

impl Kind {
    pub fn mark(self) -> &'static str {
        match self {
            Self::Added => "A",
            Self::Conflicted => "U",
            Self::Deleted => "D",
            Self::Modified => "M",
            Self::Renamed => "R",
            Self::Untracked => "?",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub kind: Kind,
    /// `None` for untracked and binary files, which have no lines to count.
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Status {
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// HEAD has a commit; an unborn branch has none to diff or log from.
    pub born: bool,
    pub files: Vec<FileChange>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    /// Committer time, in seconds since the Unix epoch.
    pub time: i64,
}

/// `XY` from porcelain v2 as one kind, staged and unstaged together.
fn kind(xy: &str) -> Kind {
    if xy.contains('D') {
        Kind::Deleted
    } else if xy.contains('A') {
        Kind::Added
    } else {
        Kind::Modified
    }
}

pub fn status(text: &str) -> Status {
    let mut status = Status::default();
    let mut fields = text.split('\0').filter(|field| !field.is_empty());
    while let Some(entry) = fields.next() {
        if let Some(header) = entry.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => status.born = value != "(initial)",
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_owned()),
                "branch.upstream" => status.upstream = Some(value.to_owned()),
                "branch.ab" => {
                    for count in value.split(' ') {
                        if let Some(ahead) = count.strip_prefix('+') {
                            status.ahead = ahead.parse().unwrap_or(0);
                        } else if let Some(behind) = count.strip_prefix('-') {
                            status.behind = behind.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        // Ordinary entries have eight fields before the path, renames nine
        // (and their old path as the next NUL field), conflicts ten. Paths
        // may hold spaces, so the split stops at the path.
        let (kind, path) = match entry.as_bytes().first() {
            Some(b'1') => (
                entry.split(' ').nth(1).map(kind),
                entry.splitn(9, ' ').nth(8),
            ),
            Some(b'2') => {
                fields.next();
                (Some(Kind::Renamed), entry.splitn(10, ' ').nth(9))
            }
            Some(b'u') => (Some(Kind::Conflicted), entry.splitn(11, ' ').nth(10)),
            Some(b'?') => (Some(Kind::Untracked), entry.get(2..)),
            _ => (None, None),
        };
        if let (Some(kind), Some(path)) = (kind, path) {
            status.files.push(FileChange {
                path: path.to_owned(),
                kind,
                additions: None,
                deletions: None,
            });
        }
    }
    status
}

/// Adds `diff --numstat -z` counts to the files they name. A rename prints
/// an empty path and then its old and new paths as two more NUL fields.
pub fn apply_numstat(files: &mut [FileChange], text: &str) {
    let mut fields = text.split('\0');
    while let Some(entry) = fields.next() {
        let mut parts = entry.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            fields.next();
            fields.next().unwrap_or_default()
        } else {
            path
        };
        // `-` marks a binary file, which keeps no counts.
        let (Ok(added), Ok(deleted)) = (added.parse(), deleted.parse()) else {
            continue;
        };
        if let Some(file) = files.iter_mut().find(|file| file.path == path) {
            file.additions = Some(added);
            file.deletions = Some(deleted);
        }
    }
}

/// `log -z --format=%H%x1f%ct%x1f%an%x1f%s`.
pub fn log(text: &str) -> Vec<Commit> {
    text.split('\0')
        .filter_map(|record| {
            let mut parts = record.trim_start_matches('\n').splitn(4, '\x1f');
            let sha = parts.next()?.to_owned();
            let time = parts.next()?.parse().ok()?;
            let author = parts.next()?.to_owned();
            let subject = parts.next()?.to_owned();
            (!sha.is_empty()).then_some(Commit {
                sha,
                subject,
                author,
                time,
            })
        })
        .collect()
}

/// Entries in `git status --porcelain -z`. A rename or copy carries its old
/// path as one more NUL field, which is not a file of its own.
pub fn count_porcelain(status: &str) -> usize {
    let mut fields = status.split('\0').filter(|field| !field.is_empty());
    let mut count = 0;
    while let Some(entry) = fields.next() {
        count += 1;
        if matches!(entry.as_bytes().first(), Some(b'R' | b'C')) {
            fields.next();
        }
    }
    count
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

//! The few reads the Changes and Files panels make beside Git, on the machine
//! a workspace is on: this one's disk, or a remote daemon's host through
//! `/bin/sh` over its ssh login. Nothing here writes, on either.

use crate::{
    git::{self, Captured},
    herdr::{Target, ssh},
};
use std::{
    fs,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

/// A read's deadline. A remote one pays a round trip per call, and on the
/// first after a while the sign-in the shared login had dropped.
pub fn deadline(target: &Target, local: Duration) -> Instant {
    let allowed = match target {
        Target::Local => local,
        Target::Ssh(_) => local * 3,
    };
    Instant::now() + allowed
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not start ssh")]
    Spawn(#[source] std::io::Error),
    #[error("the host took too long to answer")]
    Timeout,
}

/// `script` under `/bin/sh` on `host`, with `args` as `$1`…, keeping at most
/// `limit` + 1 bytes of what it prints.
pub fn script(host: &str, script: &str, args: &[&str], deadline: Instant, limit: usize) -> Result<Captured, Error> {
    git::capture(ssh::script(host, script, args), deadline, limit)
        .map_err(Error::Spawn)?
        .ok_or(Error::Timeout)
}

/// Which of `paths` exist, in one round trip on a remote host.
pub fn existing(target: &Target, paths: &[&str], deadline: Instant) -> Vec<bool> {
    let Target::Ssh(host) = target else {
        return paths.iter().map(|path| Path::new(path).exists()).collect();
    };
    const EXISTS: &str = r#"for path; do if [ -e "$path" ]; then echo 1; else echo 0; fi; done"#;
    let answer = script(host, EXISTS, paths, deadline, 4 * paths.len())
        .ok()
        .filter(|done| done.status.success())
        .map(|done| done.stdout)
        .unwrap_or_default();
    let mut lines = answer.split(|&byte| byte == b'\n');
    paths.iter().map(|_| lines.next() == Some(b"1")).collect()
}

/// A regular file's first `limit` + 1 bytes, not through a symlink, so a
/// caller can tell one larger than `limit`. `None` when it is no such file.
pub fn read_plain(target: &Target, path: &str, limit: u64, deadline: Instant) -> Option<Vec<u8>> {
    let Target::Ssh(host) = target else {
        let metadata = fs::symlink_metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        fs::File::open(path).ok()?.take(limit + 1).read_to_end(&mut bytes).ok()?;
        return Some(bytes);
    };
    const READ: &str = r#"[ -f "$1" ] && [ ! -L "$1" ] || exit 3
exec head -c "$2" -- "$1""#;
    let keep = usize::try_from(limit).ok()?;
    let done = script(host, READ, &[path, &(limit + 1).to_string()], deadline, keep).ok()?;
    done.status.success().then_some(done.stdout)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn local_reads_skip_symlinks_and_keep_one_byte_past_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "hello").unwrap();
        let file = file.to_str().unwrap();
        let soon = deadline(&Target::Local, Duration::from_secs(5));
        assert_eq!(read_plain(&Target::Local, file, 3, soon).unwrap(), b"hell");
        assert_eq!(read_plain(&Target::Local, file, 10, soon).unwrap(), b"hello");
        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(file, &link).unwrap();
            assert_eq!(read_plain(&Target::Local, link.to_str().unwrap(), 10, soon), None);
        }
        let missing = dir.path().join("nope");
        assert_eq!(
            existing(&Target::Local, &[file, missing.to_str().unwrap()], soon),
            [true, false]
        );
    }
}

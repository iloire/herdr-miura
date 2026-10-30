# Herdr on another machine

The host picker at the left of the status bar lists the named `Host` entries of `~/.ssh/config`
(and the files it `Include`s). Picking one replaces the connection: the window then shows that
machine's Herdr, until you pick another or **This Mac**. The choice is remembered for the next launch.

## What the host needs

- Herdr 0.9.5 or later, with health checks (older daemons are refused with a message saying so).
- `herdr` on the `PATH`, or in one of the places Herdr itself looks: `~/.local/bin`, Homebrew,
  mise, Nix profiles. The remote daemon is started if it is not running, by Herdr's own
  `herdr remote-client-bridge`.
- A POSIX shell. Windows hosts are not supported yet.

## How it connects

One `ssh` child per connection, with Herdr's non-interactive policy (`src-tauri/src/herdr/ssh.rs`):
keys or an agent only (`BatchMode=yes`, no password prompts), `StrictHostKeyChecking=yes`, a 10 s
connect timeout, keepalives, and no forwarding. Logins to one host share a master connection for
ten minutes, its socket in a private `/tmp/herdr-tauri-<uid>` directory. Login banners before
Herdr's ready marker are skipped. The session pings the daemon after 5 s of quiet and drops a link
that does not answer in 10 s, or in 3 s after the window comes back to the front.

Failures are read from ssh's stderr into plain messages: unknown host, unreachable, sign-in refused,
unknown or changed host key, Herdr not installed.

## Host keys

A key ssh has never seen is never accepted silently. The app fetches the host's keys with
`ssh-keyscan`, shows their fingerprints, and writes those exact keys to your known_hosts only when you
choose **Trust and connect**. Cancel has the focus, so a stray Enter declines. Compare the
fingerprints with the host's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on it). A
**changed** key is never replaced by the app: fix known_hosts yourself once you know why it changed.

## While attached to a remote host

The terminal, sidebar, tabs and commands work as they do locally. Whatever reads this Mac's disk or
runs its `herdr` (the Changes panel, changed-file counts, opening a folder, moving a tab to another
workspace) is refused, since the paths name folders on the other machine. Copy path still works.
The Changes panel's fetch, push and pull are refused with it and stay hidden, as Git would have to run
over there; nothing reaches this Mac's checkouts or credentials on the remote's behalf.
Land on a worktree's card is hidden and refused the same way: the worktree is a folder over there, and
its rebase, check and removal would have to run there too. Land it from a Herdr window on that machine.

## Testing against a real host

```sh
HERDR_TEST_SSH_HOST=<alias> cargo test --manifest-path src-tauri/Cargo.toml live_ssh_host -- --ignored
```

The host's key must already be known. It connects through the same `ssh` command the app uses,
waits for a snapshot, and stays quiet past a health ping.

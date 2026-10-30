# Stable and Edge

Two builds of the app stay open on Ivan's Mac, attached to the same Herdr daemon.

| | Stable | Edge |
| --- | --- | --- |
| App | `~/Applications/Herdr Tauri.app` | `~/Applications/Herdr Edge.app` |
| Identifier | `com.herdr.tauri` | `com.herdr.tauri.edge` |
| Moves when | `herdr-channels promote` | a commit lands on local `main` |
| Prompt queue | the daily one | its own, empty unless used |
| Build | full release profile (LTO) | release without LTO, incremental |
| Window | no strip | `DEV · edge <commit>` strip and title |
| Icon | yellow and cyan, `icons/icon.icns` | violet, `icons/edge/icon.icns` |

`herdr-channels` (`~/dotfiles/bin`) is the whole mechanism; the `herdr_channels` role in
`ansible-recipes` installs its three LaunchAgents:

- `com.ivan.herdr-channels` is the only builder. Every 5 seconds it fetches `main` from
  `~/code/herdr-tauri` into its own clone under `~/Library/Caches/herdr-channels`, so it never sees
  uncommitted work and never touches the main checkout. It reads the local branch, not `origin`,
  because that is where work lands.
- `com.ivan.herdr-stable` and `com.ivan.herdr-edge` run the apps at login and bring them back after a
  crash. ⌘Q is respected: a quit app stays closed until the next login or the next install.

A new commit replaces Edge only once it has built. A commit that fails to build leaves the last good
Edge running, raises a notification and is not retried, and the next commit tries again. The panes
live in the daemon, so a restart costs the window state and nothing else.

```sh
herdr-channels status           # what each channel runs, and what is building
herdr-channels promote          # move Stable to the commit Edge runs, and wait for it
herdr-channels promote <ref>    # or to a given commit
```

Logs: `~/Library/Logs/herdr-channels.log`, and the last build of each channel in
`~/Library/Caches/herdr-channels/<channel>-build.log`.

`HERDR_BUILD_LABEL` at build time sets the dev strip in a built app (`vite.config.ts`). Both channels
share `~/.config/herdr/config-tauri.toml`; only the app data folder is Edge's own.

The Dock tells the three apart: `tauri.conf.json` names the red `icons/dev/icon.icns`, so a `tauri dev`
window and any build made by hand are red, and `herdr-channels` passes each channel its own icon with
`--config`. The red and violet ones are `icons/icon.icns` tinted, a single size like the original:

```sh
iconutil -c iconset src-tauri/icons/icon.icns -o orig.iconset
magick orig.iconset/icon_512x512.png -colorspace Gray -fill '#E5484D' -tint 100 -colorspace sRGB PNG32:dev.iconset/icon_512x512.png
iconutil -c icns dev.iconset -o src-tauri/icons/dev/icon.icns
```

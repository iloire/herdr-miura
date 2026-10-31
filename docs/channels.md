# Stable and Edge

Two builds of the app can stay open side by side, attached to the same Herdr daemon.

| | Stable | Edge |
| --- | --- | --- |
| Identifier | `com.herdr.tauri` | `com.herdr.tauri.edge` |
| Moves when | promoted by hand | a commit lands on local `main` |
| Prompt queue | the daily one | its own, empty unless used |
| Build | full release profile (LTO) | release without LTO, incremental |
| Window | no strip | `DEV · edge <commit>` strip and title |
| Icon | yellow and cyan, `icons/icon.icns` | violet, `icons/edge/icon.icns` |

Both are ordinary `tauri build`s, made by a script kept outside this repo from a separate clone of `main`, so they
never see uncommitted work. A commit that fails to build leaves the last good Edge running. The panes live in the
daemon, so a restart costs the window state and nothing else.

`HERDR_BUILD_LABEL` at build time sets the dev strip in a built app (`vite.config.ts`). Both channels
share `~/.config/herdr/config-tauri.toml`; only the app data folder is Edge's own.

The Dock tells the three apart: `tauri.conf.json` names the red `icons/dev/icon.icns`, so a `tauri dev`
window and any build made by hand are red, and a channel build passes its own icon with
`--config`. The red and violet ones are `icons/icon.icns` tinted, a single size like the original:

```sh
iconutil -c iconset src-tauri/icons/icon.icns -o orig.iconset
magick orig.iconset/icon_512x512.png -colorspace Gray -fill '#E5484D' -tint 100 -colorspace sRGB PNG32:dev.iconset/icon_512x512.png
iconutil -c icns dev.iconset -o src-tauri/icons/dev/icon.icns
```

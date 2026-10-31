# Stable and Edge

Two builds of the app can stay open side by side, attached to the same Herdr daemon.

| | Stable | Edge |
| --- | --- | --- |
| Identifier | `com.herdr.tauri` | `com.herdr.tauri.edge` |
| Moves when | promoted by hand | a commit lands on local `main` |
| Prompt queue | the daily one | its own, empty unless used |
| Build | full release profile (LTO) | release without LTO, incremental |
| Window | no strip | `DEV · edge <commit>` strip and title |
| Icon | dark tile, `icons/icon.icns` | violet tile, `icons/edge/icon.icns` |

Both are ordinary `tauri build`s, made by a script kept outside this repo from a separate clone of `main`, so they
never see uncommitted work. A commit that fails to build leaves the last good Edge running. The panes live in the
daemon, so a restart costs the window state and nothing else.

The app was called Herdr Tauri. Names kept on disk did not change with it, since a new one would strand what is
there: the `com.herdr.tauri` identifiers, `config-tauri.toml`, `queue-tauri.json` and the `herdr-tauri.host` key.

`HERDR_BUILD_LABEL` at build time sets the dev strip in a built app (`vite.config.ts`). Both channels
share `~/.config/herdr/config-tauri.toml`; only the app data folder is Edge's own.

The Dock tells the three apart: `tauri.conf.json` names the red `icons/dev/icon.icns`, so a `tauri dev`
window and any build made by hand are red, and a channel build passes its own icon with
`--config`. All three are the same mark on a different tile, drawn from `src-tauri/icons/icon.svg`. After changing
the SVG, run `scripts/icons.sh` to redraw every icon.

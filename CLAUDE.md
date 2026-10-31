# Herdr Miura

## Dev windows

The app in daily use is not built from this checkout: Stable and Edge run from their own clone
([docs/channels.md](docs/channels.md)), and Edge rebuilds itself when a commit lands on `main`.

- Run a dev window on its own port so it doesn't collide with another on 1420. Use 1430, 1440, … and
  pick one that is free:

  ```sh
  npx tauri dev --config '{"build":{"devUrl":"http://localhost:1430","beforeDevCommand":"npx vite --port 1430 --strictPort"}}'
  ```

  A dev window on a branch never runs the daily prompt queue. One on `main` shares Stable's folder and runs it only if
  Stable is closed, as whichever window opens first holds the queue's lock. To try the queue in a dev window, give it its
  own folder: add `"identifier":"com.herdr.tauri.dev"` to that `--config`.

  The dev window's `DEV · <branch>` strip (absent on `main`) tells the instances apart.
- Run `npm run check` before committing.

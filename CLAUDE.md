# Herdr Tauri

## New work goes in its own worktree

Start every new feature or piece of work in a separate git worktree on its own branch, never in the
main checkout. The main checkout stays on `main`, running the app Ivan uses every day, and each feature
in progress runs as its own dev instance next to it. That way each one can be debugged and tested on
its own.

- Create it under `.claude/worktrees/<name>` on a branch named `feat/<name>` (or `fix/…`), cut from
  `main`. Then run `npm install` inside it. The first `tauri dev` there compiles the Rust side from
  scratch, so expect it to be slow.
- Run it on its own port so it doesn't collide with the main app on 1420. Use 1430, 1440, … and pick
  one that is free:

  ```sh
  npx tauri dev --config '{"build":{"devUrl":"http://localhost:1430","beforeDevCommand":"npx vite --port 1430 --strictPort"}}'
  ```

  The dev window's `DEV · <branch>` strip (absent on `main`) tells the instances apart.
- Run `npm run check` inside the worktree before landing.
- Land it by rebasing onto `main` and fast-forwarding. Then remove the worktree and delete the
  branch in the same turn (`git worktree remove .claude/worktrees/<name>` + `git branch -d <branch>`),
  and confirm that `git worktree list` no longer shows it.
- Only a small fix that Ivan asks for directly in the main checkout, or a docs-only edit, may skip the
  worktree.

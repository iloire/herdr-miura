// What a row in the Changes panel offers, decided from the row alone.

import type { ChangedFile } from "./store";

/// The file on disk, as a person would paste it. `path` is relative to the checkout.
export function absolutePath(checkout: string, path: string): string {
  return `${checkout.replace(/\/+$/, "")}/${path}`;
}

/// Only a file that is there can be opened: a deleted one is not, and Git
/// lists an untracked folder as `dir/`.
export function canOpen(file: ChangedFile): boolean {
  return file.mark !== "D" && !file.path.endsWith("/");
}

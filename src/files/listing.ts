import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export interface Listing {
  /// The checkout's top folder; every path is relative to it.
  root: string;
  files: string[];
  total_files: number;
  /// Ignored files, and ignored folders whole with a trailing `/`, when asked for.
  ignored: string[];
}

export type FileContents =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string }
  | { type: "binary"; size: number }
  | { type: "too_large"; size: number };

export type ListingState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; listing: Listing | null }
  | { phase: "failed"; error: string };

export function readFile(root: string, path: string): Promise<FileContents> {
  return invoke<FileContents>("read_file", { root, path });
}

/// Saves `text` over the file, unless it no longer holds `base`. A `null` base
/// overwrites. Answers whether it wrote.
export function writeFile(root: string, path: string, text: string, base: string | null): Promise<boolean> {
  return invoke<boolean>("write_file", { root, path, text, base });
}

/// One level of the ignored folder at `path`, folders with a trailing `/`.
export function listFolder(root: string, path: string): Promise<string[]> {
  return invoke<string[]>("list_folder", { root, path });
}

const SHOW_IGNORED_KEY = "files-show-ignored";

/// Whether the Files panel lists ignored files, kept in this window's storage.
export function loadShowIgnored(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(SHOW_IGNORED_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveShowIgnored(show: boolean, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(SHOW_IGNORED_KEY, String(show));
  } catch {
    // Only a convenience lost.
  }
}

/// A file named in a pane's text: its checkout, and its path inside that.
export interface FoundFile {
  root: string;
  path: string;
}

/// The file `name` means from `directory`, or null when it means none there.
export function findFile(directory: string, name: string): Promise<FoundFile | null> {
  return invoke<FoundFile | null>("find_file", { directory, name });
}

/// The files of the checkout `directory` sits in while `open`, the ignored ones
/// too with `ignored`: read when the panel opens or either changes, and again
/// when the window comes back, since files usually change elsewhere.
export function useListing(directory: string | null, open: boolean, ignored: boolean): ListingState {
  const [state, setState] = useState<ListingState>({ phase: "idle" });
  useEffect(() => {
    if (!open || !directory) {
      setState({ phase: "idle" });
      return;
    }
    let live = true;
    let reading = false;
    const refresh = () => {
      if (reading) return;
      reading = true;
      invoke<Listing | null>("list_files", { directory, ignored })
        .then((listing) => live && setState({ phase: "ready", listing }))
        .catch((error) => live && setState({ phase: "failed", error: String(error) }))
        .finally(() => (reading = false));
    };
    // Moving between folders of one checkout keeps its tree up meanwhile.
    setState((last) => (last.phase === "ready" ? last : { phase: "loading" }));
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [directory, open, ignored]);
  return state;
}

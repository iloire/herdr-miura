import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export interface Listing {
  /// The checkout's top folder; every path is relative to it.
  root: string;
  files: string[];
  total_files: number;
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

/// The files of the checkout `directory` sits in while `open`: read when the
/// panel opens or the directory changes, and again when the window comes back,
/// since files usually change elsewhere.
export function useListing(directory: string | null, open: boolean): ListingState {
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
      invoke<Listing | null>("list_files", { directory })
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
  }, [directory, open]);
  return state;
}

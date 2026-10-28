import { invoke } from "@tauri-apps/api/core";

/// The apps a folder can open in; the bridge maps each to a program.
export type Opener = "files" | "vs_code" | "github_desktop";

export function openFolder(path: string, opener: Opener): Promise<void> {
  return invoke("open_folder", { path, with: opener });
}

export function copyPath(path: string): Promise<void> {
  return invoke("copy_path", { path });
}

/// A path as herdr-gpui's folder cards show it: the home folder as `~`.
export function tildePath(path: string, home: string | null): string {
  const root = home?.replace(/\/+$/, "");
  if (!root) return path;
  if (path === root) return "~";
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

import { invoke } from "@tauri-apps/api/core";

/// The apps a folder can open in; the bridge maps each to a program.
export type Opener = "files" | "vs_code" | "github_desktop";

export function openFolder(path: string, opener: Opener): Promise<void> {
  return invoke("open_folder", { path, with: opener });
}

export function copyPath(path: string): Promise<void> {
  return invoke("copy_path", { path });
}

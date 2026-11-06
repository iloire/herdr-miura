import { invoke } from "@tauri-apps/api/core";
import type { FileContents } from "./listing";

/// What a terminal link to a file can do with it; the bridge maps each to an app.
export type LinkFileAction = "default" | "vs_code" | "reveal";

/// The full path of the file `name` means from `directory`, in a checkout or
/// not, or null when it means none.
export function locateFile(directory: string, name: string): Promise<string | null> {
  return invoke<string | null>("locate_file", { directory, name });
}

/// An image outside any checkout, by its full path.
export function readLinkImage(path: string): Promise<FileContents> {
  return invoke<FileContents>("read_link_image", { path });
}

/// Opens a file in its default app or VS Code, or shows it in the file manager.
/// The bridge refuses the default app for a file that would run.
export function openLinkFile(path: string, action: LinkFileAction): Promise<void> {
  return invoke("open_link_file", { path, with: action });
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/// Whether the file view would show `path` as an image, by its extension.
export function isImagePath(path: string): boolean {
  return IMAGE.test(path);
}

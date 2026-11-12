import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IS_MAC } from "../app/catalog";
import type { Controller } from "../app/controller";
import { openLinkFile } from "../files/linkFile";
import { pasteEvents } from "../terminal/mouse";
import type { MenuItem } from "./ContextMenu";
import { CodeIcon, CopyIcon, FileIcon, FolderIcon, OpenIcon, TerminalIcon } from "./icons";

/// What a row of the Files panel is and what clicking it does.
export interface TreeRow {
  folder: boolean;
  /// Whether a folder's row is open.
  expanded: boolean;
  /// Opens a file over the terminal.
  onOpen: () => void;
  /// Opens or closes a folder's row; absent while a filter shows every match open.
  onToggle?: () => void;
}

/// What a right-click on a file or folder in the Files panel offers. `path`
/// is relative to the checkout at `root`.
export function treeMenu(controller: Controller, root: string, path: string, row: TreeRow): MenuItem[][] {
  const full = `${root}/${path}`;
  const name = path.split("/").pop() ?? path;
  const copy = (text: string) => () => controller.act(writeText(text));
  const act = (action: "default" | "vs_code" | "reveal") => () => controller.act(openLinkFile(full, action));
  const reveal = { label: IS_MAC ? "Reveal in Finder" : "Show in Folder", icon: <FolderIcon />, onSelect: act("reveal") };
  const vsCode = { label: "Open in VS Code", icon: <CodeIcon />, onSelect: act("vs_code") };
  const paste: MenuItem = {
    label: "Paste Path in Terminal",
    icon: <TerminalIcon />,
    onSelect: () => {
      controller.sendInput(pasteEvents(`${path.includes(" ") ? `'${path}'` : path} `));
      controller.focusTerminal();
    },
  };
  const copies: MenuItem[] = [
    { label: "Copy Path", icon: <CopyIcon />, onSelect: copy(full) },
    { label: "Copy Relative Path", icon: <CopyIcon />, onSelect: copy(path) },
    { label: "Copy Name", icon: <CopyIcon />, onSelect: copy(name) },
  ];
  if (row.folder) {
    return [
      row.onToggle ? [{ label: row.expanded ? "Collapse" : "Expand", icon: <FolderIcon />, onSelect: row.onToggle }] : [],
      [vsCode, reveal],
      [paste],
      copies,
    ];
  }
  return [
    [{ label: "Open", icon: <FileIcon />, onSelect: row.onOpen }],
    [{ label: "Open with Default App", icon: <OpenIcon />, onSelect: act("default") }, vsCode, reveal],
    [paste],
    copies,
  ];
}

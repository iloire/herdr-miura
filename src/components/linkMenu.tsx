import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_MAC } from "../app/catalog";
import type { Controller } from "../app/controller";
import { type Located, openLinkFile } from "../files/linkFile";
import type { Link } from "../terminal/links";
import type { MenuItem } from "./ContextMenu";
import { ChangesIcon, CodeIcon, CopyIcon, FileIcon, FolderIcon, GlobeIcon, OpenIcon } from "./icons";

/// The click that does a link's first action, as a hint; ⌘ is Super off macOS.
const CLICK = IS_MAC ? "⌘-click" : undefined;

/// What a right-click on a link in a pane offers. `located` is where a file
/// link leads, or null when nothing is there.
export function linkMenu(controller: Controller, link: Link, paneId: string, located: Located | null): MenuItem[][] {
  const copy = (text: string) => controller.act(writeText(text));
  if (link.url) {
    return [
      [{ label: "Open in Browser", icon: <GlobeIcon />, hint: CLICK, onSelect: () => controller.act(openUrl(link.url!)) }],
      [{ label: "Copy URL", icon: <CopyIcon />, onSelect: () => copy(link.url!) }],
    ];
  }
  if (link.commit) {
    const commit = link.commit;
    return [
      [{ label: "Show Commit", icon: <ChangesIcon />, hint: CLICK, onSelect: () => controller.openCommitLink(commit, paneId) }],
      [{ label: "Copy Hash", icon: <CopyIcon />, onSelect: () => copy(commit) }],
    ];
  }
  if (link.image !== undefined) {
    const image = link.image;
    return [[{ label: "Show Image", icon: <FileIcon />, hint: CLICK, onSelect: () => controller.openImageLink(image, paneId) }]];
  }
  const file = link.file;
  if (!file) return [];
  if (!located) {
    return [
      [{ label: "No such file", icon: <FileIcon />, disabled: true }],
      [{ label: "Copy Text", icon: <CopyIcon />, onSelect: () => copy(file) }],
    ];
  }
  const path = located.path;
  const act = (action: "default" | "vs_code" | "reveal") => () => controller.act(openLinkFile(path, action));
  const reveal = IS_MAC ? "Reveal in Finder" : "Show in Folder";
  if (located.folder) {
    return [
      [
        { label: reveal, icon: <FolderIcon />, hint: CLICK, onSelect: act("reveal") },
        { label: "Open in VS Code", icon: <CodeIcon />, onSelect: act("vs_code") },
      ],
      [{ label: "Copy Path", icon: <CopyIcon />, onSelect: () => copy(path) }],
    ];
  }
  return [
    [{ label: "Open", icon: <FileIcon />, hint: CLICK, onSelect: () => controller.openFileLink(file, paneId) }],
    [
      { label: "Open with Default App", icon: <OpenIcon />, onSelect: act("default") },
      { label: "Open in VS Code", icon: <CodeIcon />, onSelect: act("vs_code") },
      { label: reveal, icon: <FolderIcon />, onSelect: act("reveal") },
    ],
    [{ label: "Copy Path", icon: <CopyIcon />, onSelect: () => copy(path) }],
  ];
}

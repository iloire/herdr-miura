import type { Controller } from "../app/controller";
import { copyPath, openFolder } from "../app/folder";
import type { MenuItem } from "./ContextMenu";
import { BranchIcon, CodeIcon, CopyIcon, OpenIcon } from "./icons";

/// What a right-click offers for a folder, as herdr-gpui's folder menu does.
export function folderMenu(controller: Controller, path: string): MenuItem[] {
  return [
    { label: "Open in VS Code", icon: <CodeIcon />, onSelect: () => controller.act(openFolder(path, "vs_code")) },
    {
      label: "Open in GitHub Desktop",
      icon: <BranchIcon />,
      onSelect: () => controller.act(openFolder(path, "github_desktop")),
    },
    { label: "Open Folder", icon: <OpenIcon />, onSelect: () => controller.act(openFolder(path, "files")) },
    { label: "Copy Path", icon: <CopyIcon />, onSelect: () => controller.act(copyPath(path)) },
  ];
}

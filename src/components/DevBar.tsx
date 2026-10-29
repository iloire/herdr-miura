import type { CSSProperties } from "react";
import { hueColor } from "../app/hue";

/// The branch a dev server runs, so a window from `tauri dev` cannot pass
/// for the app in daily use, nor one branch's for another's. Empty in a built app and on `main`.
export const DEV_BRANCH = __DEV_BRANCH__;

/// A strip along the window's foot in the branch's hue, naming it. Only dev
/// windows off `main` have it.
export function DevBar() {
  if (!DEV_BRANCH) return null;
  return (
    <div className="dev-bar" style={{ "--hue": hueColor(DEV_BRANCH) } as CSSProperties}>
      DEV · {DEV_BRANCH}
    </div>
  );
}

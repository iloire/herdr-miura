import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";

/// The home folder, read once, so paths under it show as `~`.
export function useHome(): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    homeDir().then(setHome, () => setHome(null));
  }, []);
  return home;
}

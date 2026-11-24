import { useEffect, useState } from "react";

/// A scan of this Mac's processes, rerun every `every` ms and when the window
/// comes back, kept as the same object while `same` says nothing changed so
/// nothing redraws. A remote host gets none: its processes are not here.
export function useLocalScan<T extends Map<string, unknown>>(
  local: boolean,
  every: number,
  read: () => Promise<T>,
  same: (a: T, b: T) => boolean,
): T {
  const [value, setValue] = useState<T>(() => new Map() as T);
  useEffect(() => {
    if (!local) {
      setValue(new Map() as T);
      return;
    }
    let scanning = false;
    let live = true;
    const refresh = () => {
      if (scanning) return;
      scanning = true;
      read()
        .then((next) => live && setValue((previous) => (same(previous, next) ? previous : next)))
        .catch(() => {})
        .finally(() => (scanning = false));
    };
    refresh();
    const timer = window.setInterval(refresh, every);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
    // `read` and `same` are module functions, fixed for the app's life.
  }, [local, every]);
  return value;
}

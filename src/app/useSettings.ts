import { useCallback, useEffect, useRef, useState } from "react";
import type { Controller } from "./controller";
import { loadSettings, resolveTheme, type Settings } from "./settings";

const LIGHT = "(prefers-color-scheme: light)";

export interface SettingsView {
  /// What the file got wrong, and a theme that would not load; empty once dismissed.
  warnings: string[];
  dismiss: () => void;
  /// The settings file's path, once read.
  path: string | null;
  /// Reads the file again, as after the Settings dialog writes it.
  reload: () => void;
}

/// Reads the settings file on launch and whenever the window comes back, hands
/// it to the controller, and shows its theme, following the system appearance
/// for a `light:…,dark:…` pair.
export function useSettings(controller: Controller): SettingsView {
  const [fileWarnings, setFileWarnings] = useState<string[]>([]);
  const [themeWarning, setThemeWarning] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    let current: Settings | null = null;
    // Answers can arrive out of order; only the last asked counts.
    let asked = 0;
    const appearance = window.matchMedia(LIGHT);
    const showTheme = (settings: Settings) => {
      const ask = ++asked;
      void resolveTheme(settings.theme, appearance.matches).then(({ theme, warning }) => {
        if (!live || ask !== asked) return;
        controller.setTheme(theme);
        setThemeWarning(warning);
      });
    };
    const reload = () => {
      loadSettings()
        .then((loaded) => {
          if (!live) return;
          current = loaded.settings;
          controller.applySettings(loaded.settings);
          setFileWarnings(loaded.warnings);
          setPath(loaded.path);
          showTheme(loaded.settings);
        })
        .catch((error) => live && setFileWarnings([`The settings file could not be read: ${String(error)}`]));
    };
    const onAppearance = () => current && showTheme(current);
    reloadRef.current = reload;
    reload();
    window.addEventListener("focus", reload);
    appearance.addEventListener("change", onAppearance);
    return () => {
      live = false;
      reloadRef.current = () => {};
      window.removeEventListener("focus", reload);
      appearance.removeEventListener("change", onAppearance);
    };
  }, [controller]);

  const all = themeWarning ? [...fileWarnings, themeWarning] : fileWarnings;
  const key = all.join("\n");
  const dismiss = useCallback(() => setDismissed(key), [key]);
  const reload = useCallback(() => reloadRef.current(), []);
  // Dismissed until the file says something new.
  return { warnings: dismissed === key ? [] : all, dismiss, path, reload };
}

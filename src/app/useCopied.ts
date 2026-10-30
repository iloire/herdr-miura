import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useState } from "react";

/// How long a copy button shows that it copied.
const COPIED_MS = 1500;

/// Copies `text` to the clipboard, and says so for a moment.
export function useCopied(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    writeText(text).then(
      () => setCopied(true),
      (error) => console.error("could not copy", error),
    );
  };
  return { copied, copy };
}

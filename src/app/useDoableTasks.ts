// The Doable tasks in the `doable.view` setting's view, read for the whole
// window: the Doable panel lists them and the status bar counts those due.
// Read often while the panel is open, seldom otherwise, and on focus.

import { useCallback, useEffect, useState } from "react";
import { noToken, readTasks, type Tasks } from "./doable";

const OPEN_MS = 60_000;
const CLOSED_MS = 5 * 60_000;

export interface DoableTasks {
  read: Tasks | null;
  /// Why the last read failed; null after one that worked.
  failed: string | null;
  /// No token is set, so nothing Doable should show.
  off: boolean;
  /// A read is under way, so a refresh button can show it.
  reading: boolean;
  refresh: () => void;
}

/// `enabled` false reads nothing, as for the `@agent` tasks without a token.
export function useDoableTasks(view: string, panelOpen: boolean, enabled = true): DoableTasks {
  const [read, setRead] = useState<Tasks | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [reading, setReading] = useState(false);
  // A view's answer must not land after the next view's.
  const [asked, setAsked] = useState(0);
  const refresh = useCallback(() => setAsked((n) => n + 1), []);

  // Another view's tasks are not this one's, even for the moment its read takes.
  useEffect(() => {
    setRead(null);
    setFailed(null);
  }, [view]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setReading(true);
    readTasks(view)
      .then((next) => {
        if (!live) return;
        setRead(next);
        setFailed(null);
        setOff(false);
      })
      .catch((error) => {
        if (!live) return;
        setFailed(String(error));
        setOff(noToken(error));
      })
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
  }, [view, asked, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(refresh, panelOpen ? OPEN_MS : CLOSED_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, panelOpen, enabled]);
  // Opening the panel reads at once rather than showing a list up to five minutes old.
  useEffect(() => {
    if (panelOpen) refresh();
  }, [panelOpen, refresh]);

  return { read, failed, off, reading, refresh };
}

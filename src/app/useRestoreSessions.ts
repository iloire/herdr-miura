import { useEffect, useMemo, useRef } from "react";
import type { Snapshot } from "../protocol";
import type { Controller } from "./controller";
import { openSessions, syncOpenSessions } from "./restoreSessions";

// Keeps the shared record of which session each pane holds, whenever that
// changes, and hands the panes of the boot before to the controller to resume.
// Local daemon only: a remote host's panes are not this computer's to resume.
export function useRestoreSessions(snapshot: Snapshot | null, local: boolean, controller: Controller): void {
  const bootId = snapshot?.boot_id ?? null;
  const panes = useMemo(() => (snapshot ? openSessions(snapshot) : []), [snapshot]);
  const key = bootId && local ? `${bootId}\n${JSON.stringify(panes)}` : null;
  const sent = useRef<string | null>(null);
  // One sync at a time, in order, so an older record never lands last.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!key || !bootId || key === sent.current) return;
    sent.current = key;
    queue.current = queue.current.then(() =>
      syncOpenSessions(bootId, panes).then(
        (left) => controller.restoreSessions(left),
        () => {
          // Not kept this time; the next change sends it again.
          sent.current = null;
        },
      ),
    );
  }, [key, bootId, panes, controller]);
}

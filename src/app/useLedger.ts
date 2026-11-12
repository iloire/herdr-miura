// Reads the outcome ledger every few seconds and when the window comes back,
// and records what is done with an entry. The ledger is this computer's, read
// whichever host the window is attached to.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Controller } from "./controller";
import { EMPTY_LEDGER, type Ledger, type Outcome, outcomes, readLedger, type ResolveHow, resolveOutcome } from "./ledger";

const POLL_MS = 10_000;

export interface LedgerView {
  /// Every entry, newest first.
  list: Outcome[];
  resolve: (id: string, how: ResolveHow) => void;
}

export function useLedger(controller: Controller): LedgerView {
  const [ledger, setLedger] = useState<Ledger>(EMPTY_LEDGER);
  const refresh = useCallback(() => {
    readLedger()
      .then(setLedger)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const resolve = useCallback(
    (id: string, how: ResolveHow) => {
      // Shown at once; the next read brings the file's own line.
      setLedger((current) => ({ ...current, resolutions: [...current.resolutions, { resolves: id, how, at: new Date().toISOString() }] }));
      controller.act(resolveOutcome(id, how).finally(refresh));
    },
    [controller, refresh],
  );
  return useMemo(() => ({ list: outcomes(ledger, Date.now()), resolve }), [ledger, resolve]);
}

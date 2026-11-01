import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Controller } from "../app/controller";

/// A failure that needs reading, with Git's or Herdr's own words kept as they
/// came. Only OK or Esc closes it, so it cannot be missed or clicked away.
export function AlertDialog({ controller }: { controller: Controller }) {
  const alert = useSyncExternalStore(controller.subscribe, () => controller.getState().alert);
  if (!alert) return null;
  const dismiss = () => controller.dismissAlert();

  return createPortal(
    <div className="palette-backdrop">
      <div
        className="palette host-key land-dialog"
        role="alertdialog"
        aria-labelledby="alert-title"
        aria-describedby="alert-message"
        onKeyDown={(event) => event.key === "Escape" && dismiss()}
      >
        <h2 id="alert-title">{alert.title}</h2>
        <pre id="alert-message" className="alert-message">
          {alert.message}
        </pre>
        <div className="host-key-actions">
          <button autoFocus className="host-key-button primary" onClick={dismiss}>
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

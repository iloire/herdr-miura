import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { clean } from "../changes/diff";
import type { Controller } from "../app/controller";

const LIST = new Intl.ListFormat("en");

/// Asks before a close stops an agent mid-task. Cancel takes the focus, so a
/// stray Enter does nothing.
export function CloseDialog({ controller }: { controller: Controller }) {
  const ask = useSyncExternalStore(controller.subscribe, () => controller.getState().closeAsk);
  if (!ask) return null;
  const cancel = () => controller.answerClose(false);
  const several = ask.agents.length > 1;

  return createPortal(
    <div className="palette-backdrop" onMouseDown={cancel}>
      <div
        className="palette host-key land-dialog"
        role="alertdialog"
        aria-labelledby="close-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && cancel()}
      >
        <h2 id="close-title">Close {clean(ask.name)}?</h2>
        <p>
          {clean(LIST.format(ask.agents))} {several ? "are" : "is"} still working here. Closing stops{" "}
          {several ? "the agents" : "the agent"} and anything {several ? "they are" : "it is"} running, partway through.
        </p>
        <div className="host-key-actions">
          <button autoFocus className="host-key-button" onClick={cancel}>
            Cancel
          </button>
          <button className="host-key-button primary" onClick={() => controller.answerClose(true)}>
            Close {ask.kind}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

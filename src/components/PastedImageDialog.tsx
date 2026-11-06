import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Controller } from "../app/controller";

/// An image from a ⌘-click: one pasted into a session, from its `[Image #1]`,
/// or a file outside any checkout. Esc or a click outside it closes.
export function PastedImageDialog({ controller }: { controller: Controller }) {
  const image = useSyncExternalStore(controller.subscribe, () => controller.getState().pastedImage);
  if (!image) return null;
  const close = () => controller.closePastedImage();
  const { title } = image;

  return createPortal(
    <div className="palette-backdrop pasted-image-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        className="pasted-image"
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        ref={(dialog) => dialog?.focus()}
        onKeyDown={(event) => event.key === "Escape" && close()}
      >
        <img src={`data:${image.mime};base64,${image.data}`} alt={title} />
      </div>
    </div>,
    document.body,
  );
}

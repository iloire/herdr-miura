import { useRef, useState } from "react";
import type { Pane } from "../app/paneWidth";

const KEY_STEP = 16;

/// A pane's inner edge: drag it to resize, double-click to reset, or focus it
/// and use the arrow keys. `clamp` holds a width to what fits right now, and
/// `onCommit` fires once a change settles; a click that moved nothing does not
/// commit, so it cannot save a width the window has only shrunk for now.
export function PaneResizer({
  pane,
  width,
  clamp,
  onChange,
  onCommit,
}: {
  pane: Pane;
  width: number;
  clamp: (width: number) => number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // A pane on the right grows as its left edge moves left.
  const grow = pane.side === "left" ? 1 : -1;
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("resizing");
  };

  return (
    <div
      className={`resizer resizer-${pane.side} ${dragging ? "dragging" : ""}`}
      style={{ [pane.side]: width }}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${pane.name}`}
      aria-valuenow={width}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width, width };
        setDragging(true);
        document.body.classList.add("resizing");
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.width = clamp(drag.current.startWidth + grow * (event.clientX - drag.current.startX));
        onChange(drag.current.width);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        if (drag.current.width !== drag.current.startWidth) onCommit(drag.current.width);
        endDrag();
      }}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onCommit(pane.default)}
      onKeyDown={(event) => {
        const step = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
        if (!step) return;
        event.preventDefault();
        const next = clamp(width + grow * step);
        if (next !== width) onCommit(next);
      }}
    />
  );
}

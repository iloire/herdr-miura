import { useRef } from "react";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampWidth } from "../app/sidebar";

const KEY_STEP = 16;

/// The sidebar's right edge: drag it to resize, double-click to reset, or
/// focus it and use the arrow keys. `onCommit` fires once a change settles.
export function SidebarResizer({
  width,
  onChange,
  onCommit,
}: {
  width: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const set = (next: number) => clampWidth(next, window.innerWidth);

  return (
    <div
      className="sidebar-resizer"
      style={{ left: width }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width, width };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.width = set(drag.current.startWidth + event.clientX - drag.current.startX);
        onChange(drag.current.width);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        onCommit(drag.current.width);
        drag.current = null;
        document.body.classList.remove("resizing");
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        document.body.classList.remove("resizing");
      }}
      onDoubleClick={() => onCommit(set(SIDEBAR_DEFAULT))}
      onKeyDown={(event) => {
        const step = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
        if (!step) return;
        event.preventDefault();
        onCommit(set(width + step));
      }}
    />
  );
}

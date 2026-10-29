import { useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Controller } from "../app/controller";
import type { MouseButton, MouseKind, PaneInputEvent, SurfacePane } from "../protocol";
import { keyInput } from "../terminal/keys";
import { Painter, measure, popupOrigin } from "../terminal/painter";
import type { Theme } from "../terminal/theme";
import { pasteEvents, wheelEvents } from "../terminal/mouse";
import { linkAt, type Link } from "../terminal/links";

const BUTTONS: MouseButton[] = ["Left", "Middle", "Right"];

function sameLink(a: Link | null, b: Link | null): boolean {
  if (!a || !b) return a === b;
  const [ax, bx] = [a.cells[0], b.cells[0]];
  return a.url === b.url && a.cells.length === b.cells.length && ax.x === bx.x && ax.y === bx.y;
}

function modifiers(event: MouseEvent | WheelEvent): number {
  return (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0);
}

/// The daemon's surface on a canvas, with a hidden textarea that owns
/// keyboard focus so text input, IME composition, and paste work natively.
export function Terminal({ controller, fontSize, theme }: { controller: Controller; fontSize: number; theme: Theme }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // A theme change repaints with the painter already there: nothing is
  // remeasured, resized or resubscribed.
  const themeRef = useRef(theme);
  const retheme = useRef<(theme: Theme) => void>(() => {});
  useEffect(() => {
    themeRef.current = theme;
    retheme.current(theme);
  }, [theme]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const input = inputRef.current;
    if (!host || !canvas || !input) return;
    const grid = controller.grid;
    const metrics = measure(fontSize);
    const painter = new Painter(canvas, metrics, themeRef.current);
    let focused = document.hasFocus();
    let composing = false;
    const repaintAll = () => painter.paint(grid, Array.from({ length: grid.height }, (_, y) => y), focused);
    retheme.current = (theme) => {
      painter.theme = theme;
      repaintAll();
    };

    // ⌘ over a URL underlines it and a ⌘-click opens it in the browser.
    let pointer: { column: number; row: number } | null = null;
    let commandHeld = false;
    const updateLink = (): Set<number> => {
      const link = commandHeld && pointer && !grid.popup ? linkAt(grid, pointer.column, pointer.row) : null;
      const rows = new Set<number>();
      if (sameLink(link, painter.link)) return rows;
      for (const cell of [...(painter.link?.cells ?? []), ...(link?.cells ?? [])]) rows.add(cell.y);
      painter.link = link;
      return rows;
    };
    const hover = () => {
      const rows = updateLink();
      if (rows.size) painter.paint(grid, rows, focused);
      if (painter.link) canvas.style.cursor = "pointer";
      else if (canvas.style.cursor === "pointer") canvas.style.cursor = "text";
    };

    // Frames arrive faster than the display refreshes; paint once per frame.
    let pending = new Set<number>();
    let scheduled = 0;
    const unsubscribe = controller.onFrame((dirty) => {
      for (const y of dirty) pending.add(y);
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        const rows = pending;
        pending = new Set();
        // The text under the pointer may have changed under a held ⌘.
        for (const y of updateLink()) rows.add(y);
        painter.paint(grid, rows, focused);
      });
    });
    repaintAll();

    // Size the grid to the host. Debounced: a window drag resizes many times.
    let resizeTimer = 0;
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      const cols = Math.max(1, Math.floor(width / metrics.cellWidth));
      const rows = Math.max(1, Math.floor(height / metrics.cellHeight));
      void controller.setSurface({
        cols,
        rows: Math.min(rows, Math.floor(1_000_000 / cols)),
        cell_width_px: Math.round(metrics.cellWidth),
        cell_height_px: Math.round(metrics.cellHeight),
      });
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resize, 40);
    });
    observer.observe(host);
    resize();

    // Pointer position in cells, relative to the grid.
    const cellAt = (event: MouseEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
        column: Math.floor((event.clientX - bounds.left) / metrics.cellWidth),
        row: Math.floor((event.clientY - bounds.top) / metrics.cellHeight),
      };
    };
    const mouse = (kind: MouseKind, pane: SurfacePane, column: number, row: number, mods: number): PaneInputEvent => ({
      Mouse: {
        kind,
        position: {
          Cell: { column: Math.max(0, column - pane.inner_rect.x), row: Math.max(0, row - pane.inner_rect.y) },
        },
        geometry: null,
        modifiers: mods,
        lines: 0,
      },
    });
    // The pane a press started in owns the drag and its release.
    let pressed: { pane: SurfacePane; button: MouseButton } | null = null;
    let splitDrag: { tabId: string; path: boolean[]; horizontal: boolean; start: number; size: number } | null = null;

    const onMouseDown = (event: MouseEvent) => {
      event.preventDefault();
      input.focus();
      const at = cellAt(event);
      if (event.metaKey && event.button === 0 && !grid.popup) {
        const link = linkAt(grid, at.column, at.row);
        if (link) {
          void openUrl(link.url);
          return;
        }
      }
      const split = grid.splitAt(at.column, at.row);
      const tabId = controller.getState().snapshot?.focused_tab_id;
      if (split && tabId) {
        const horizontal = split.direction === "Horizontal";
        splitDrag = {
          tabId,
          path: split.path,
          horizontal,
          start: (horizontal ? split.area.x : split.area.y) * (horizontal ? metrics.cellWidth : metrics.cellHeight),
          size: (horizontal ? split.area.width : split.area.height) * (horizontal ? metrics.cellWidth : metrics.cellHeight),
        };
        return;
      }
      if (grid.popup) {
        const origin = popupOrigin(grid, grid.popup, metrics.cellWidth, metrics.cellHeight);
        if (!grid.popup.mouse_reporting) return;
        const column = Math.floor((at.x - origin.x) / metrics.cellWidth);
        const row = Math.floor((at.y - origin.y) / metrics.cellHeight);
        const button = BUTTONS[event.button] ?? "Left";
        controller.sendInput([
          { Mouse: { kind: { Down: button }, position: { Cell: { column, row } }, geometry: null, modifiers: modifiers(event), lines: 0 } },
        ]);
        return;
      }
      const pane = grid.paneAt(at.column, at.row);
      if (!pane) return;
      if (!pane.focused) controller.request("pane.focus", { pane_id: pane.pane_id });
      if (pane.mouse_reporting) {
        const button = BUTTONS[event.button] ?? "Left";
        pressed = { pane, button };
        controller.sendInput([mouse({ Down: button }, pane, at.column, at.row, modifiers(event))], pane.pane_id);
      }
    };
    const onMouseMove = (event: MouseEvent) => {
      const at = cellAt(event);
      if (splitDrag) {
        const along = splitDrag.horizontal ? at.x : at.y;
        const ratio = Math.min(0.95, Math.max(0.05, (along - splitDrag.start) / splitDrag.size));
        controller.request("layout.set_split_ratio", { tab_id: splitDrag.tabId, path: splitDrag.path, ratio });
        return;
      }
      const split = grid.splitAt(at.column, at.row);
      canvas.style.cursor = split ? (split.direction === "Horizontal" ? "col-resize" : "row-resize") : "text";
      pointer = { column: at.column, row: at.row };
      commandHeld = event.metaKey;
      hover();
      if (pressed) {
        controller.sendInput(
          [mouse({ Drag: pressed.button }, pressed.pane, at.column, at.row, modifiers(event))],
          pressed.pane.pane_id,
        );
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      splitDrag = null;
      if (!pressed) return;
      const at = cellAt(event);
      controller.sendInput([mouse({ Up: pressed.button }, pressed.pane, at.column, at.row, modifiers(event))], pressed.pane.pane_id);
      pressed = null;
    };

    // Wheel deltas accumulate until they make a whole line.
    let wheelRemainder = 0;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = cellAt(event);
      const pane = grid.popup ? undefined : grid.paneAt(at.column, at.row);
      if (!pane && !grid.popup) return;
      const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * metrics.cellHeight : event.deltaY;
      wheelRemainder -= pixels / metrics.cellHeight;
      const lines = Math.trunc(wheelRemainder);
      if (lines === 0) return;
      wheelRemainder -= lines;
      const column = pane ? at.column - pane.inner_rect.x : 0;
      const row = pane ? at.row - pane.inner_rect.y : 0;
      const stepwise = pane ? pane.mouse_reporting || pane.alternate_screen_active : true;
      controller.sendInput(wheelEvents(lines, column, row, modifiers(event), stepwise), pane?.pane_id);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (composing || event.isComposing) return;
      if (controller.shortcut(event)) {
        event.preventDefault();
        return;
      }
      if (event.metaKey && (event.key === "v" || event.key === "c")) return; // native paste/copy
      const key = keyInput(event);
      if (!key) return;
      event.preventDefault();
      controller.sendInput([key]);
    };
    const onInput = () => {
      if (composing) return;
      const text = input.value;
      input.value = "";
      if (text) controller.sendInput([{ TextCommit: text }]);
    };
    const onCompositionStart = () => {
      composing = true;
    };
    const onCompositionEnd = () => {
      composing = false;
      onInput();
    };
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain");
      if (text) controller.sendInput(pasteEvents(text));
    };
    const onCommand = (event: KeyboardEvent) => {
      if (event.key !== "Meta") return;
      commandHeld = event.type === "keydown";
      hover();
    };
    const onFocus = () => {
      focused = true;
      controller.setWindowFocus(true);
      repaintAll();
    };
    const onBlur = () => {
      focused = false;
      // ⌘-Tab away never delivers the key's release.
      commandHeld = false;
      updateLink();
      controller.setWindowFocus(false);
      repaintAll();
    };

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onCommand);
    window.addEventListener("keyup", onCommand);
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("input", onInput);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("paste", onPaste);
    input.addEventListener("focus", onFocus);
    input.addEventListener("blur", onBlur);
    input.focus();
    controller.focusTerminal = () => input.focus();
    return () => {
      retheme.current = () => {};
      controller.focusTerminal = () => {};
      unsubscribe();
      cancelAnimationFrame(scheduled);
      clearTimeout(resizeTimer);
      observer.disconnect();
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onCommand);
      window.removeEventListener("keyup", onCommand);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("input", onInput);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("paste", onPaste);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
    };
  }, [controller, fontSize]);

  return (
    <div className="terminal" ref={hostRef} onMouseDown={() => inputRef.current?.focus()}>
      <canvas ref={canvasRef} />
      <textarea
        ref={inputRef}
        className="terminal-input"
        aria-label="Terminal input"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
}

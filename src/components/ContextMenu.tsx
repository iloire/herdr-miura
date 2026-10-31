import { type CSSProperties, Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { type Grouped, menuGroups } from "../app/menuGroups";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /// Quiet text at the row's end: a shortcut, or why it is disabled.
  hint?: string;
  /// Runs, then the menu closes.
  onSelect?: () => void;
  /// A page of choices shown in place of this menu, with a way back.
  items?: Grouped<MenuItem>;
  disabled?: boolean;
  /// Draws this item as one row of round choices; `label` names the row.
  swatches?: MenuSwatch[];
}

/// A round choice in a swatch row: picking it runs, then the menu closes.
export interface MenuSwatch {
  label: string;
  /// A CSS color; `null` draws a hollow one, for no color of its own.
  color: string | null;
  /// The current choice, marked with a ring.
  current: boolean;
  onSelect: () => void;
}

export interface MenuAt {
  x: number;
  y: number;
  items: Grouped<MenuItem>;
}

const EDGE = 8;
const SWATCH = "context-menu-swatch";

/// A right-click menu at a point, kept inside the window. Arrow keys move, ←
/// and → along a swatch row, which ↑ and ↓ take as one stop, landing on its
/// current choice. Enter picks, Escape or a click elsewhere closes, and focus
/// goes back to where it was (usually the terminal).
export function ContextMenu({ menu, onClose }: { menu: MenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<{ title: string; items: Grouped<MenuItem> }[]>([{ title: "", items: menu.items }]);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const page = pages[pages.length - 1];

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      // Give focus back only if nothing took it, such as a rename field the menu opened.
      if (document.activeElement === document.body || !document.activeElement) previous?.focus();
    };
  }, [onClose]);

  // Flip into the window once the menu's size is known, and focus its first item.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const { width, height } = box.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE, Math.min(menu.x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(menu.y, window.innerHeight - height - EDGE)),
    });
    box.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu.x, menu.y, pages]);

  const pick = (item: Pick<MenuItem, "items" | "label" | "onSelect">) => {
    if (item.items) return setPages([...pages, { title: item.label, items: item.items }]);
    onClose();
    item.onSelect?.();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const active = document.activeElement as HTMLButtonElement;
    const onSwatch = active.classList.contains(SWATCH);
    const swatches = buttons.filter((button) => button.classList.contains(SWATCH));
    const stops = buttons.filter(
      (button) => !swatches.includes(button) || button === active || (!onSwatch && button.getAttribute("aria-checked") === "true"),
    );
    const step = (list: HTMLButtonElement[], by: number) => list[(list.indexOf(active) + by + list.length) % list.length]?.focus();
    if (event.key === "ArrowDown") step(stops, 1);
    else if (event.key === "ArrowUp") step(stops, -1);
    else if (onSwatch && event.key === "ArrowRight") step(swatches, 1);
    else if (onSwatch && event.key === "ArrowLeft") step(swatches, -1);
    else if (event.key === "Escape") pages.length > 1 ? setPages(pages.slice(0, -1)) : onClose();
    else if (event.key === "ArrowLeft" && pages.length > 1) setPages(pages.slice(0, -1));
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {pages.length > 1 && (
        <button className="context-menu-back" role="menuitem" onClick={() => setPages(pages.slice(0, -1))}>
          ‹ {page.title}
        </button>
      )}
      {menuGroups(page.items).map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <div className="context-menu-divider" role="separator" />}
          {group.map((item) =>
            item.swatches ? (
              <div key={item.label} className="context-menu-swatches" role="group" aria-label={item.label}>
                {item.swatches.map((swatch) => (
                  <button
                    key={swatch.label}
                    className={swatch.color ? SWATCH : `${SWATCH} hollow`}
                    role="menuitemradio"
                    aria-checked={swatch.current}
                    aria-label={swatch.label}
                    title={swatch.label}
                    style={swatch.color ? ({ "--swatch": swatch.color } as CSSProperties) : undefined}
                    onClick={() => pick(swatch)}
                  />
                ))}
              </div>
            ) : (
              <button key={item.label} role="menuitem" disabled={item.disabled} onClick={() => pick(item)}>
                <span className="context-menu-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="context-menu-label">{item.label}</span>
                {item.hint && <span className="context-menu-hint">{item.hint}</span>}
                {item.items && <span className="context-menu-more">›</span>}
              </button>
            ),
          )}
        </Fragment>
      ))}
    </div>
  );
}

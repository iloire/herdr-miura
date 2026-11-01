import { type CSSProperties, Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { type Grouped, menuGroups } from "../app/menuGroups";
import { placeMenu } from "../app/menuPlace";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /// Quiet text at the row's end: a shortcut, or why it is disabled.
  hint?: string;
  /// Runs, then the menu closes.
  onSelect?: () => void;
  /// A submenu that opens beside this row on hover, click, Enter or →.
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

/// One open panel. The first is the menu, each after it a submenu of a row in
/// the panel before.
interface Level {
  title: string;
  items: Grouped<MenuItem>;
  /// The row that opened this panel, absent on the menu itself.
  opener?: HTMLButtonElement;
  /// Whether its first item takes focus, as the keyboard needs. A hover leaves it.
  takeFocus: boolean;
}

const MENU = "context-menu";
const SWATCH = "context-menu-swatch";
/// Long enough to cross a row on the way into an open submenu without it changing.
const HOVER_MS = 120;
/// How far a submenu sits over its parent's edge, and above its row, to line up
/// its first item with that row across the panel's border and padding.
const OVERLAP = 3;
const PADDING = 6;

/// A right-click menu at a point, kept inside the window. Arrow keys move, ←
/// and → along a swatch row, which ↑ and ↓ take as one stop, landing on its
/// current choice. A row with a submenu opens it on hover, → or Enter, and ←
/// leaves it. Enter picks, Escape or a click elsewhere closes, and focus goes
/// back to where it was (usually the terminal).
export function ContextMenu({ menu, onClose }: { menu: MenuAt; onClose: () => void }) {
  const [levels, setLevels] = useState<Level[]>([{ title: "", items: menu.items, takeFocus: true }]);
  const timer = useRef<number | undefined>(undefined);

  /// Replaces whatever a hover was about to do, with `run` or with nothing.
  const later = (run?: () => void) => {
    window.clearTimeout(timer.current);
    if (run) timer.current = window.setTimeout(run, HOVER_MS);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const away = (event: Event) => {
      if (!(event.target as Element).closest?.(`.${MENU}`)) onClose();
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

  /// Keeps the panels up to `depth`, with this row's submenu after them if it has one.
  const show = (depth: number, item?: MenuItem, opener?: HTMLButtonElement, takeFocus = false) =>
    setLevels((open) => [
      ...open.slice(0, depth + 1),
      ...(item?.items ? [{ title: item.label, items: item.items, opener, takeFocus }] : []),
    ]);

  /// Closes the panel at `depth` and all after it, the keyboard back on its row.
  const back = (depth: number) => {
    later();
    levels[depth].opener?.focus();
    setLevels(levels.slice(0, depth));
  };

  const pick = (depth: number, item: MenuItem | MenuSwatch, row: HTMLButtonElement, byKey: boolean) => {
    later();
    if ("items" in item && item.items) return show(depth, item, row, byKey);
    onClose();
    item.onSelect?.();
  };

  const hover = (depth: number, item: MenuItem, row: HTMLButtonElement) => {
    // One cursor for mouse and keys, so the arrows go on from here and the
    // keyboard never lands on a panel that has closed.
    row.focus({ preventScroll: true });
    if (levels[depth + 1]?.opener === row) later();
    else if (item.items || levels[depth + 1]) later(() => show(depth, item, row));
  };

  return levels.map((level, depth) => (
    <Panel
      key={`${depth} ${level.title}`}
      level={level}
      at={menu}
      openTitle={levels[depth + 1]?.title}
      onEscape={() => (levels.length > 1 ? back(levels.length - 1) : onClose())}
      onBack={depth > 0 ? () => back(depth) : undefined}
      onPick={(item, row, byKey) => pick(depth, item, row, byKey)}
      onHover={(item, row) => hover(depth, item, row)}
      onHoverElsewhere={() => levels[depth + 1] && later(() => show(depth))}
      onEnter={() => later()}
    />
  ));
}

interface PanelProps {
  level: Level;
  at: { x: number; y: number };
  /// The title of the submenu open from this panel, whose row stays lit.
  openTitle?: string;
  onEscape: () => void;
  onBack?: () => void;
  onPick: (item: MenuItem | MenuSwatch, row: HTMLButtonElement, byKey: boolean) => void;
  onHover: (item: MenuItem, row: HTMLButtonElement) => void;
  /// The pointer is over this panel but on no row that could open a submenu.
  onHoverElsewhere: () => void;
  onEnter: () => void;
}

function Panel({ level, at, openTitle, onEscape, onBack, onPick, onHover, onHoverElsewhere, onEnter }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  // Place it once its size is known, and focus its first item.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const row = level.opener?.getBoundingClientRect();
    const parent = level.opener?.closest(`.${MENU}`)?.getBoundingClientRect();
    const anchor = row && parent ? { x: parent.right - OVERLAP, y: row.top - PADDING, flipX: parent.left + OVERLAP } : at;
    const { width, height } = box.getBoundingClientRect();
    setPosition(placeMenu(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
    if (level.takeFocus) box.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [at.x, at.y, level]);

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
    else if (event.key === "Escape") onEscape();
    else if (event.key === "ArrowLeft" && onBack) onBack();
    else if (event.key === "ArrowRight" && active.hasAttribute("aria-haspopup")) active.click();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className={MENU}
      role="menu"
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      onPointerEnter={onEnter}
      onPointerOver={(event) => {
        if (!(event.target as Element).closest('[role="menuitem"]')) onHoverElsewhere();
      }}
    >
      {menuGroups(level.items).map((group, index) => (
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
                    onClick={(event) => onPick(swatch, event.currentTarget, event.detail === 0)}
                  />
                ))}
              </div>
            ) : (
              <button
                key={item.label}
                role="menuitem"
                disabled={item.disabled}
                aria-haspopup={item.items ? "menu" : undefined}
                aria-expanded={item.items ? openTitle === item.label : undefined}
                onPointerEnter={(event) => onHover(item, event.currentTarget)}
                onClick={(event) => onPick(item, event.currentTarget, event.detail === 0)}
              >
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

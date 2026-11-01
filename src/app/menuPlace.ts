const EDGE = 8;

export interface MenuAnchor {
  x: number;
  y: number;
  /// The right edge to end at when `x` runs out of window: a submenu flips to
  /// its parent's other side.
  flipX?: number;
}

/// Where a menu of this size goes: at its anchor, kept inside the window.
export function placeMenu(anchor: MenuAnchor, size: { width: number; height: number }, view: { width: number; height: number }) {
  const fits = anchor.x + size.width <= view.width - EDGE;
  const left = fits || anchor.flipX === undefined ? anchor.x : anchor.flipX - size.width;
  return {
    left: Math.max(EDGE, Math.min(left, view.width - size.width - EDGE)),
    top: Math.max(EDGE, Math.min(anchor.y, view.height - size.height - EDGE)),
  };
}

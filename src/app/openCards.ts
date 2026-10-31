// Which workspace cards show their details. What the chevron chose in `manual`
// is this window's, kept in its storage as the sort order is, and a card stays
// open until it is closed. `auto` follows the card's agents instead (`AutoCard`)
// and writes nothing there, so going back to `manual` restores that choice.

import type { CardDetailsMode } from "./settings";

const KEY = "workspace-cards-open";

export function loadOpenCards(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Set<string> {
  try {
    const ids: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveOpenCards(cards: ReadonlySet<string>, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify([...cards]));
  } catch {
    // A card that does not stay open is only a convenience lost.
  }
}

/// Whether a card shows its details. `chosen` is the state of a mode that has
/// one: the stored choice in `manual`, `autoCardShown` in `auto`. `always` and
/// `never` override it without forgetting it, so going back restores it.
export function cardOpen(mode: CardDetailsMode, expandable: boolean, chosen: boolean): boolean {
  return expandable && (mode === "always" || (mode !== "never" && chosen));
}

/// Whether cards have a chevron in this mode: the others would ignore it.
export function hasChevron(mode: CardDetailsMode): boolean {
  return mode === "manual" || mode === "auto";
}

/// `cards` with `id` flipped, and without workspaces that are gone, so the
/// stored list cannot grow forever.
export function toggleCard(cards: ReadonlySet<string>, id: string, live: readonly string[]): Set<string> {
  const next = new Set([...cards].filter((card) => live.includes(card)));
  if (!next.delete(id)) next.add(id);
  return next;
}

/// How long a card stays open after its agents stop calling for it, so one that
/// finishes and starts again at once neither closes the card nor ends a chevron
/// override. It is also how quickly a card can open and close again.
export const AUTO_CLOSE_HOLD_MS = 2000;

/// A card's state in `auto`, kept only while the window is in that mode.
export interface AutoCard {
  /// The automatic state: what the rule says, once it has held.
  open: boolean;
  /// When the rule started saying closed, while `open` is still true.
  closingSince: number | null;
  /// What the chevron chose against `open`, until `open` next changes.
  chevron: boolean | null;
}

export type AutoCards = ReadonlyMap<string, AutoCard>;

/// `card` once its agents want it open or not at `now`. A card opens at once,
/// as what opens it may need you, and closes when that has held. The same
/// object comes back when nothing changed.
export function stepAutoCard(card: AutoCard | undefined, wants: boolean, now: number): AutoCard {
  if (!card) return { open: wants, closingSince: null, chevron: null };
  if (wants) {
    if (!card.open) return { open: true, closingSince: null, chevron: null };
    return card.closingSince === null ? card : { ...card, closingSince: null };
  }
  if (!card.open) return card;
  if (card.closingSince === null) return { ...card, closingSince: now };
  return now - card.closingSince < AUTO_CLOSE_HOLD_MS ? card : { open: false, closingSince: null, chevron: null };
}

/// `cards` stepped to `wants`, one entry per workspace there, so a workspace that
/// is gone leaves. The same map comes back when nothing changed.
export function stepAutoCards(cards: AutoCards, wants: ReadonlyMap<string, boolean>, now: number): AutoCards {
  const next = new Map<string, AutoCard>();
  let changed = cards.size !== wants.size;
  for (const [id, wanted] of wants) {
    const card = cards.get(id);
    const stepped = stepAutoCard(card, wanted, now);
    changed ||= stepped !== card;
    next.set(id, stepped);
  }
  return changed ? next : cards;
}

/// Whether a card in `auto` shows its details.
export function autoCardShown(card: AutoCard): boolean {
  return card.chevron ?? card.open;
}

/// `card` after a click on its chevron. Clicking back to the automatic state
/// drops the override rather than keeping one that says the same.
export function chooseAutoCard(card: AutoCard): AutoCard {
  const chevron = !autoCardShown(card);
  return { ...card, chevron: chevron === card.open ? null : chevron };
}

/// When the next held close is due, or null when none is waiting.
export function nextAutoClose(cards: AutoCards): number | null {
  const since = [...cards.values()].flatMap((card) => (card.closingSince === null ? [] : [card.closingSince]));
  return since.length > 0 ? Math.min(...since) + AUTO_CLOSE_HOLD_MS : null;
}

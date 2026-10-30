// Which workspace cards show their details. It is this window's, kept in its
// storage as the sort order is, and a card stays open until it is closed.

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

/// `cards` with `id` flipped, and without workspaces that are gone, so the
/// stored list cannot grow forever.
export function toggleCard(cards: ReadonlySet<string>, id: string, live: readonly string[]): Set<string> {
  const next = new Set([...cards].filter((card) => live.includes(card)));
  if (!next.delete(id)) next.add(id);
  return next;
}

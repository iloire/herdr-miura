// Runs the `auto` card state over time: `openCards.ts` decides, this feeds it
// each render and wakes it when a held close falls due.

import { useCallback, useEffect, useState } from "react";
import { type AutoCards, autoCardShown, chooseAutoCard, nextAutoClose, stepAutoCards } from "./openCards";

const NO_CARDS: AutoCards = new Map();

/// `wants` says, by workspace id, which cards their agents want open; empty
/// outside `auto`, which drops every card and so any chevron override with it.
export function useAutoCards(wants: ReadonlyMap<string, boolean>): {
  shown: (workspaceId: string) => boolean;
  toggle: (workspaceId: string) => void;
} {
  const [stored, setStored] = useState(NO_CARDS);
  const [wakes, setWakes] = useState(0);
  // Set while rendering, as React allows for state that follows props: a card
  // that opens does so in this paint, not the next.
  const cards = stepAutoCards(stored, wants, Date.now());
  if (cards !== stored) setStored(cards);

  const due = nextAutoClose(cards);
  useEffect(() => {
    if (due === null) return;
    const timer = window.setTimeout(() => setWakes((count) => count + 1), Math.max(0, due - Date.now()));
    return () => window.clearTimeout(timer);
  }, [due, wakes]);

  const toggle = useCallback((workspaceId: string) => {
    setStored((current) => {
      const card = current.get(workspaceId);
      return card ? new Map(current).set(workspaceId, chooseAutoCard(card)) : current;
    });
  }, []);

  const shown = (workspaceId: string) => {
    const card = cards.get(workspaceId);
    return card !== undefined && autoCardShown(card);
  };
  return { shown, toggle };
}

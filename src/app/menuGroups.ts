/// A menu's items: one flat list, or groups with a divider between them.
export type Grouped<T> = T[] | T[][];

/// The groups a menu draws, a divider going between each: empty ones are
/// dropped, so none leaves a stray divider, and a flat list is a single group.
export function menuGroups<T>(menu: Grouped<T>): T[][] {
  const groups = (Array.isArray(menu[0]) ? menu : [menu]) as T[][];
  return groups.filter((group) => group.length > 0);
}

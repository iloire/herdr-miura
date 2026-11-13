import type { Grid } from "./grid";

/// A URL, commit hash, file path or pasted image found in the grid, with the
/// cells it covers (it may wrap rows).
export interface Link {
  url?: string;
  commit?: string;
  file?: string;
  /// The number of Claude Code's `[Image #1]`.
  image?: number;
  /// A shell command Claude Code shows as `! cmd` to run in its prompt, without the `!`.
  command?: string;
  cells: { x: number; y: number }[];
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s<>"'`]*)?/g;

/// What could be a commit: a lone run of hex digits, not part of a path, a
/// file name, a UUID or a color. Only Git can tell whether it is one.
const COMMIT_PATTERN = /(?<![\w/#=-]|\w\.)[0-9a-f]{7,64}(?![\w/-]|\.\w)/g;

/// What could be a path: names joined by `/`, from `/`, `~/`, `./` or `../`. A
/// `:12` after it is left out, as the view opens at the top of the file.
const PATH_PATTERN = /(?<![\p{L}\p{N}_.\/~@+-])(?:~\/|\.{1,2}\/|\/)?[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)*/gu;

/// A word is only a path with a `/` in it, or a name ending in an extension.
const PATH_SHAPE = /\/|[^.]\.[a-zA-Z]\w*$/;

/// How Claude Code shows an image pasted into a prompt.
const IMAGE_PATTERN = /\[Image #(\d+)\]/g;

/// Prose punctuation that ends a sentence rather than the URL.
const TRAILING = /[.,;:!?'"*]+$/;

/// Drops trailing punctuation, and a closing bracket the URL never opened.
function trim(text: string): string {
  let url = text.replace(TRAILING, "");
  for (const [open, close] of ["()", "[]", "{}"]) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) {
      url = url.slice(0, -1).replace(TRAILING, "");
    }
  }
  return url;
}

/// What a program's own OSC 8 link points at: a web address opens as one, a
/// `file://` one as the path it names, and any other scheme as nothing.
function target(href: string): { url: string } | { file: string } | null {
  if (/^(https?|mailto):/i.test(href)) return { url: href };
  if (/^file:/i.test(href)) {
    try {
      return { file: decodeURIComponent(new URL(href).pathname) };
    } catch {
      return null;
    }
  }
  return null;
}

/// The URL, commit hash, file path or pasted image under a cell, if any. A
/// link the program drew itself, as Claude Code does for `[name](url)`, wins
/// over what its text looks like. Only the disk can
/// tell whether a path is a file. Text is read only within the pane holding
/// the cell, so a neighbouring pane's text never joins it, and a row whose
/// last column is filled continues onto the next one, as a wrapped URL does.
export function linkAt(grid: Grid, column: number, row: number): Link | null {
  const pane = grid.paneAt(column, row);
  if (!pane) return null;
  const { x: left, y: top, width, height } = pane.inner_rect;
  if (column < left || column >= left + width || row < top || row >= top + height) return null;
  const right = left + width - 1;
  const filled = (y: number) => grid.cell(right, y)[0].trim() !== "";

  let first = row;
  while (first > top && filled(first - 1)) first--;
  let last = row;
  while (last < top + height - 1 && filled(last)) last++;

  // The logical line's text, and for each UTF-16 unit the cell it came from.
  let text = "";
  const origin: { x: number; y: number }[] = [];
  for (let y = first; y <= last; y++) {
    let x = left;
    // A continuation row's indent is the wrapper's, not part of the line.
    if (y > first) while (x < right && grid.cell(x, y)[0] === " ") x++;
    for (; x <= right; x++) {
      const [symbol, , , , skip] = grid.cell(x, y);
      if (skip) continue;
      const unit = symbol === "" ? " " : symbol;
      text += unit;
      for (let i = 0; i < unit.length; i++) origin.push({ x, y });
    }
  }

  const href = grid.cell(column, row)[5];
  const linked = href ? target(href) : null;
  if (linked) {
    const cells = origin.filter((cell, i) => cell !== origin[i - 1] && grid.cell(cell.x, cell.y)[5] === href);
    return { ...linked, cells };
  }

  const command = commandAt(grid, column, row);
  if (command) return command;

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trim(match[0]);
    const start = match.index;
    const covered = origin.slice(start, start + url.length);
    if (!covered.some((cell) => cell.x === column && cell.y === row)) continue;
    const cells = covered.filter((cell, i) => i === 0 || cell !== covered[i - 1]);
    return { url: url.startsWith("http") ? url : `http://${url}`, cells };
  }
  for (const match of text.matchAll(IMAGE_PATTERN)) {
    const covered = origin.slice(match.index, match.index + match[0].length);
    if (covered.some((cell) => cell.x === column && cell.y === row)) return { image: Number(match[1]), cells: covered };
  }
  for (const match of text.matchAll(COMMIT_PATTERN)) {
    const covered = origin.slice(match.index, match.index + match[0].length);
    if (covered.some((cell) => cell.x === column && cell.y === row)) return { commit: match[0], cells: covered };
  }
  for (const match of text.matchAll(PATH_PATTERN)) {
    const file = trim(match[0]);
    if (!PATH_SHAPE.test(file)) continue;
    const covered = origin.slice(match.index, match.index + file.length);
    if (covered.some((cell) => cell.x === column && cell.y === row)) return { file, cells: covered };
  }
  return null;
}

/// How many rows above and below the pointer a `! cmd` is looked for in.
const COMMAND_REACH = 4;

/// A `! cmd` under a cell: Claude Code's way of asking you to run a command
/// in its prompt, drawn as inline code, so in a colour of its own. The `!`
/// must differ in colour from the text before it, and the command runs on in
/// that colour, across Claude Code's word wrap, up to text of another colour.
function commandAt(grid: Grid, column: number, row: number): Link | null {
  const pane = grid.paneAt(column, row);
  if (!pane) return null;
  const { x: left, y: top, width, height } = pane.inner_rect;
  const right = left + width - 1;
  // The rows' text as one run of cells, a wrapped row's indent and trailing
  // blanks left out, and a row break counted as a blank.
  const run: { x: number; y: number; symbol: string; fg: number }[] = [];
  for (let y = Math.max(top, row - COMMAND_REACH); y <= Math.min(top + height - 1, row + COMMAND_REACH); y++) {
    let start = left;
    while (start <= right && grid.cell(start, y)[0].trim() === "") start++;
    let end = right;
    while (end >= start && grid.cell(end, y)[0].trim() === "") end--;
    if (end < start) {
      run.push({ x: -1, y, symbol: "\n", fg: -1 }); // a blank row ends any command
      continue;
    }
    if (run.length) run.push({ x: -1, y, symbol: " ", fg: -1 });
    for (let x = start; x <= end; x++) {
      const [symbol, fg, , , skip] = grid.cell(x, y);
      if (!skip) run.push({ x, y, symbol: symbol || " ", fg });
    }
  }
  const blank = (i: number) => run[i]?.symbol.trim() === "";
  for (let i = 0; i < run.length; i++) {
    const bang = run[i];
    if (bang.symbol !== "!" || (i > 0 && !blank(i - 1)) || !blank(i + 1) || run[i + 1].symbol === "\n") continue;
    let before = i - 1;
    while (before >= 0 && blank(before) && run[before].symbol !== "\n") before--;
    if (before >= 0 && run[before].symbol !== "\n" && run[before].fg === bang.fg) continue;
    let end = i + 1;
    while (end + 1 < run.length && run[end + 1].symbol !== "\n" && (blank(end + 1) || run[end + 1].fg === bang.fg)) end++;
    while (blank(end)) end--;
    const cells = run.slice(i, end + 1).filter((cell) => cell.x >= 0);
    const command = run.slice(i + 1, end + 1).map((cell) => cell.symbol).join("").trim();
    if (!command) continue;
    if (cells.some((cell) => cell.x === column && cell.y === row)) {
      return { command, cells: cells.map(({ x, y }) => ({ x, y })) };
    }
    i = end;
  }
  return null;
}

import { syntaxTree } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

// Live table editing: Tab/Shift-Tab hop between cells while the cursor is
// inside a Markdown table, re-padding the pipes only after a hop so typing
// mid-cell never reflows under the user's fingers.

/** A conservative table line: optional indent, then a leading pipe. */
export function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line);
}

/** The `| --- | :-: |` divider under the header. */
export function isSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

export interface TableBlock {
  /** Index of the header line. */
  start: number;
  /** Index of the last line (inclusive). */
  end: number;
}

/**
 * Finds the table containing `index`, or null. A block is a run of pipe-led
 * lines whose second line is a separator row; anything looser is left alone.
 */
export function findTable(lines: string[], index: number): TableBlock | null {
  if (index < 0 || index >= lines.length || !isTableLine(lines[index]!)) return null;
  let start = index;
  while (start > 0 && isTableLine(lines[start - 1]!)) start--;
  let end = index;
  while (end + 1 < lines.length && isTableLine(lines[end + 1]!)) end++;
  if (end - start < 1 || !isSeparatorLine(lines[start + 1]!)) return null;
  return { start, end };
}

/** Splits a row into trimmed cell contents, ignoring escaped `\|` pipes. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "|" && isPipe(line, i)) {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  // The outer pipes yield empty first/last entries; drop them.
  if (cells.length > 1 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Which cell `offset` (a character index into `line`) falls in. */
function isPipe(line: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && line[--at] === "\\") slashes++;
  return slashes % 2 === 0;
}

export function cellIndexAt(line: string, offset: number): number {
  let pipes = 0;
  for (let i = 0; i < offset && i < line.length; i++) {
    if (line[i] === "|" && isPipe(line, i)) pipes++;
  }
  // A leading pipe fences the first cell rather than opening a second one.
  const leading = /^\s*\|/.test(line) ? 1 : 0;
  return Math.max(0, pipes - leading);
}

interface ParsedSep {
  left: boolean[];
  right: boolean[];
}

function parseSeparator(cells: string[]): ParsedSep {
  return {
    left: cells.map((c) => c.startsWith(":")),
    right: cells.map((c) => c.endsWith(":")),
  };
}

function separatorCell(width: number, left: boolean, right: boolean): string {
  const dashes = Math.max(1, width - (left ? 1 : 0) - (right ? 1 : 0));
  return `${left ? ":" : ""}${"-".repeat(dashes)}${right ? ":" : ""}`;
}

/**
 * Returns re-padded copies of lines[start..end]: every column as wide as its
 * widest cell (min 3 so the separator stays valid), single-space padding,
 * alignment colons preserved. Rows shorter than the header gain empty cells.
 */
export function alignTable(lines: string[], start: number, end: number): string[] {
  const slice = lines.slice(start, end + 1);
  const indents = slice.map((l) => /^\s*/.exec(l)![0]);
  const header = splitRow(slice[0]!);
  const sep = parseSeparator(splitRow(slice[1]!));
  const cols = Math.max(header.length, ...slice.filter((_, i) => i !== 1).map((line) => splitRow(line).length));
  const rows = slice.map((l, i) => {
    if (i === 1) return [] as string[]; // separator is rebuilt from `sep`
    const cells = splitRow(l);
    while (cells.length < cols) cells.push("");
    return cells.slice(0, cols);
  });
  const widths = Array.from({ length: cols }, (_, c) => {
    let w = 3;
    for (const row of rows) {
      if (row.length === 0) continue;
      w = Math.max(w, row[c]!.length);
    }
    return w;
  });
  // Right-aligned columns pad on the left so the content hugs the colon side.
  const pad = (c: string, i: number) => (sep.right[i] && !sep.left[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!));
  const emit = (cells: string[]) => `| ${cells.map(pad).join(" | ")} |`;
  return slice.map((_, i) => {
    if (i === 1) {
      return indents[i]! + emit(widths.map((w, c) => separatorCell(w, sep.left[c] ?? false, sep.right[c] ?? false)));
    }
    return indents[i]! + emit(rows[i]!);
  });
}

/** Character offset of cell `col`'s content start within an aligned row line. */
function cellOffset(line: string, col: number): number {
  let pipes = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && isPipe(line, i)) {
      pipes++;
      if (pipes === col + 1) {
        // Step past the single padding space that alignTable emits.
        return Math.min(i + 2, line.length);
      }
    }
  }
  return line.length;
}

/** Moves the cursor one cell forward (dir 1) or back (dir -1); false when not in a table. */
export function moveCell(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const cursorLine = state.doc.lineAt(pos);
  const lines: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) lines.push(state.doc.line(i).text);
  const table = findTable(lines, cursorLine.number - 1);
  if (!table) return false;

  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node.name !== "Table" && node.parent) node = node.parent;
  if (node.name !== "Table") return false;

  const cols = Math.max(...lines.slice(table.start, table.end + 1).map((line) => splitRow(line).length));
  let row = cursorLine.number - 1;
  let col = cellIndexAt(cursorLine.text, pos - cursorLine.from);
  col = Math.min(col, cols - 1);

  let targetRow = row;
  let targetCol = col + dir;
  let newRow = false;
  if (targetCol >= cols) {
    targetCol = 0;
    targetRow++;
    if (targetRow === table.start + 1) targetRow++; // skip the separator
    if (targetRow > table.end) {
      newRow = true;
      targetRow = table.end + 1;
    }
  } else if (targetCol < 0) {
    targetRow--;
    if (targetRow === table.start + 1) targetRow--;
    if (targetRow < table.start) return true; // already at the first cell; swallow, don't indent
    targetCol = cols - 1;
  }

  const work = lines.slice(table.start, table.end + 1);
  if (newRow) work.push(`|${" |".repeat(cols)}`);
  const aligned = alignTable(work, 0, work.length - 1);

  const from = state.doc.line(table.start + 1).from;
  const to = state.doc.line(table.end + 1).to;
  const alignedRow = aligned[targetRow - table.start]!;
  const anchor = from + aligned.slice(0, targetRow - table.start).reduce((n, l) => n + l.length + 1, 0) + cellOffset(alignedRow, targetCol);
  view.dispatch({
    changes: { from, to, insert: aligned.join("\n") },
    selection: { anchor },
    userEvent: "input.table",
  });
  return true;
}

/** Table-aware Tab/Shift-Tab; falls through to the default keymap outside tables. */
export const tableKeymap = Prec.high(
  keymap.of([
    { key: "Tab", run: (v) => moveCell(v, 1) },
    { key: "Shift-Tab", run: (v) => moveCell(v, -1) },
  ]),
);

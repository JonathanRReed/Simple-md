import { syntaxTree } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

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

/** Character offset of a cell's content, preserving its existing padding. */
function cellOffset(line: string, col: number): number {
  let cell = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "|" || !isPipe(line, i)) continue;
    if (++cell !== col) continue;
    let at = i + 1;
    while (at < line.length && /[ \t]/.test(line[at]!)) at++;
    return at;
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
  const row = cursorLine.number - 1;
  const rowCols = splitRow(cursorLine.text).length;
  let col = cellIndexAt(cursorLine.text, pos - cursorLine.from);
  col = Math.min(col, rowCols - 1);

  let targetRow = row;
  let targetCol = col + dir;
  let newRow = false;
  if (targetCol >= rowCols) {
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
    targetCol = splitRow(lines[targetRow]!).length - 1;
  }

  if (newRow) {
    const last = state.doc.line(table.end + 1);
    const indent = /^[ \t]*/.exec(last.text)![0];
    const row = `${indent}|${" |".repeat(cols)}`;
    view.dispatch({
      changes: { from: last.to, insert: `\n${row}` },
      selection: { anchor: last.to + 1 + cellOffset(row, targetCol) },
      userEvent: "input.table",
    });
  } else {
    const target = state.doc.line(targetRow + 1);
    view.dispatch({ selection: { anchor: target.from + cellOffset(target.text, targetCol) } });
  }
  return true;
}

/** Table-aware Tab/Shift-Tab; falls through to the default keymap outside tables. */
export const tableKeymap = Prec.high(
  keymap.of([
    { key: "Tab", run: (v) => moveCell(v, 1) },
    { key: "Shift-Tab", run: (v) => moveCell(v, -1) },
  ]),
);

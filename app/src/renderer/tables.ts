import { syntaxTree } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

import { rowCells, separator, tableAt, columnAt, contentOffset } from "./table-source.js";
export const isTableLine = (line: string): boolean => /^\s*\|/.test(line);
export const isSeparatorLine = separator;
export const findTable = tableAt;
export const splitRow = (line: string): string[] => rowCells(line).map(cell => line.slice(cell.from, cell.to).trim());
export const cellIndexAt = columnAt;
const cellOffset = contentOffset;

/** Moves the cursor one cell forward (dir 1) or back (dir -1); false when not in a table. */
export function moveCell(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const pos = state.selection.main.head;
  const cursorLine = state.doc.lineAt(pos);
  const lines: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) lines.push(state.doc.line(i).text);
  const table = findTable(lines, cursorLine.number - 1);
  if (!table) return false;

  let node = syntaxTree(state).resolveInner(pos, pos === state.doc.length ? -1 : 1);
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
    const row = /^\s*\|/.test(last.text) ? `${indent}|${" |".repeat(cols)}` : `${indent}${Array<string>(cols).fill(" ").join("|")}`;
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

/** Rendered rows omit the delimiter row; map a clicked cell back to its source. */
export function cellSourceOffset(source: string, row: number, column: number): number {
  const lines = source.split("\n");
  const index = Math.min(row === 0 ? 0 : row + 1, lines.length - 1);
  return lines.slice(0, index).reduce((offset, line) => offset + line.length + 1, 0) + cellOffset(lines[index]!, column);
}

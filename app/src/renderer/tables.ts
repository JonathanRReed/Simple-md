import { syntaxTree } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

import { rowCells, separator, tableAt, columnAt, contentOffset, continuationPrefix } from "./table-source.js";
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
  let row = syntaxTree(state).resolveInner(pos, pos === state.doc.length ? -1 : 1);
  if (row.name === "Table") row = syntaxTree(state).resolveInner(pos, -1);
  while (row.parent && row.parent.name !== "Table") row = row.parent;
  const table = row.parent;
  if (table?.name !== "Table" || !table.firstChild) return false;
  const source = state.sliceDoc(row.from, row.to), cols = splitRow(source).length;
  const col = Math.min(cellIndexAt(source, pos - row.from), cols - 1);
  let target = row, targetCol = col + dir;
  if (targetCol >= cols) {
    let next = row.nextSibling;
    if (next?.name === "TableDelimiter") next = next.nextSibling;
    if (!next) {
      const header = state.sliceDoc(table.firstChild.from, table.firstChild.to);
      const last = state.doc.lineAt(table.to), current = state.doc.lineAt(row.from);
      const prefix = continuationPrefix(current.text.slice(0, row.from - current.from));
      const content = `|${" |".repeat(splitRow(header).length)}`;
      view.dispatch({ changes: { from: last.to, insert: `\n${prefix}${content}` }, selection: { anchor: last.to + 1 + prefix.length + cellOffset(content, 0) }, userEvent: "input.table" });
      return true;
    }
    target = next; targetCol = 0;
  } else if (targetCol < 0) {
    let previous = row.prevSibling;
    if (previous?.name === "TableDelimiter") previous = previous.prevSibling;
    if (!previous) return true;
    target = previous; targetCol = splitRow(state.sliceDoc(target.from, target.to)).length - 1;
  }
  const text = state.sliceDoc(target.from, target.to);
  view.dispatch({ selection: { anchor: target.from + cellOffset(text, targetCol) } });
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

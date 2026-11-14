import type { SyntaxNode } from "@lezer/common";
import { parser, GFM } from "@lezer/markdown";
import { changedSelection, dominantEnding, preserveFinalNewline, sourceLines, type SourceEdit, type SourceSelection, type SourceLine } from "./source-edit.js";

export interface CellRange { from: number; to: number }
/** Pipes in escaped text and matched code spans are cell contents. */
export function rowCells(line: string): CellRange[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "`") {
      let end = i + 1; while (line[end] === "`") end++;
      const run = line.slice(i, end);
      let close = line.indexOf(run, end);
      while (close >= 0 && (line[close - 1] === "`" || line[close + run.length] === "`")) close = line.indexOf(run, close + run.length);
      if (close >= 0) { i = close + run.length - 1; continue; }
      i = end - 1; continue;
    }
    if (line[i] === "|") pipes.push(i);
  }
  const cells: CellRange[] = [];
  let from = 0;
  for (const pipe of pipes) { cells.push({ from, to: pipe }); from = pipe + 1; }
  cells.push({ from, to: line.length });
  if (pipes.length && !line.slice(0, pipes[0]).trim()) cells.shift();
  if (pipes.length && !line.slice(pipes.at(-1)! + 1).trim()) cells.pop();
  return cells;
}
export function separator(line: string): boolean {
  const cells = rowCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(line.slice(cell.from, cell.to).trim()));
}
const markdownTables = parser.configure(GFM);
type TableLine = SourceLine & { wholeFrom: number; prefix: string };
function lineIndex(lines: readonly SourceLine[], position: number): number {
  let lo = 0, hi = lines.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (lines[mid]!.end <= position) lo = mid + 1; else hi = mid; }
  return Math.min(lo, lines.length - 1);
}
function tableContext(text: string, lines: TableLine[], index: number): { start: number; end: number } | null {
  const active = lines[index];
  if (!active) return null;
  let found: { start: number; end: number } | null = null;
  const source = text.replace(/^\uFEFF/, " ").replace(/\r\n|\r/g, "\n");
  const parsedLines = sourceLines(source);
  const rawOffset = (position: number) => {
    const at = lineIndex(parsedLines, position);
    return (at === 0 ? 0 : lines[at]!.wholeFrom) + position - parsedLines[at]!.from;
  };
  markdownTables.parse(source).iterate({ from: parsedLines[index]!.from, to: parsedLines[index]!.to, enter(ref) {
    if (ref.name !== "Table") return;
    const first = ref.node.firstChild, last = ref.node.lastChild;
    if (!first || !last) return false;
    found = { start: lineIndex(lines, rawOffset(first.from)), end: lineIndex(lines, rawOffset(last.to)) };
    for (let row: SyntaxNode | null = first; row; row = row.nextSibling) {
      const rowFrom = rawOffset(row.from), at = lineIndex(lines, rowFrom), line = lines[at]!;
      const from = Math.min(line.to, rowFrom);
      lines[at] = { ...line, prefix: text.slice(line.wholeFrom, from), from, text: text.slice(from, line.to) };
    }
    return false;
  } });
  return found;
}
export function tableAt(lines: readonly string[], index: number): { start: number; end: number } | null {
  const text = lines.join("\n");
  return tableContext(text, sourceLines(text).map(line => ({ ...line, wholeFrom: line.from, prefix: "" })), index);
}
export function continuationPrefix(prefix: string): string {
  return prefix.replace(/(?:[-+*]|\d+[.)])[ \t]+$/, marker => " ".repeat(marker.length));
}
export function columnAt(line: string, offset: number): number {
  const cells = rowCells(line);
  const col = cells.findIndex(cell => offset <= cell.to);
  return col < 0 ? Math.max(0, cells.length - 1) : col;
}
export function contentOffset(line: string, column: number): number {
  const cell = rowCells(line)[column];
  return cell ? cell.from + (/^[ \t]*/.exec(line.slice(cell.from, cell.to))?.[0].length ?? 0) : line.length;
}
export type TableCommand = "insert-table" | "row-above" | "row-below" | "column-left" | "column-right" | "delete-row" | "delete-column" | "row-up" | "row-down" | "align-left" | "align-center" | "align-right" | "align-none";
function tableEditRaw(text: string, selection: SourceSelection, command: TableCommand): SourceEdit | null {
  const eol = dominantEnding(text), lines = sourceLines(text).map(line => ({ ...line, wholeFrom: line.from, prefix: "" }));
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  selection = { from: Math.max(bom, selection.from), to: Math.max(bom, selection.to) };
  const index = lines.findIndex(line => selection.from <= line.to);
  if (command === "insert-table") {
    const line = lines[index]!;
    const before = selection.from > line.from ? eol + eol : "";
    const after = selection.to < line.to ? eol + eol : "";
    const insert = `${before}| Header | Header |${eol}| --- | --- |${eol}|  |  |${eol}|  |  |${after}`;
    const at = selection.from + before.length + 2;
    return { changes: [{ ...selection, insert }], selection: { from: at, to: at + 6 } };
  }
  const table = tableContext(text, lines, index);
  if (!table) return null;
  const row = lines[index]!, col = columnAt(row.text, selection.from - row.from);
  const count = rowCells(lines[table.start]!.text).length;
  const prefix = continuationPrefix(row.prefix);
  const newRow = () => `|${Array<string>(count).fill("  ").join("|")}|`;
  if (command === "row-above" || command === "row-below") {
    if (index === table.start && command === "row-above") {
      const blank = newRow(), delimiter = lines[table.start + 1]!;
      const cursor = row.from + contentOffset(blank, col);
      return { changes: [{ from: row.from, to: row.to, insert: blank }, { from: delimiter.to, to: delimiter.to, insert: eol + prefix + row.text }], selection: { from: cursor, to: cursor } };
    }
    // Inserting on the delimiter creates the first body row.
    const target = Math.max(table.start + 2, index + (command === "row-below" ? 1 : 0));
    const before = target > table.end;
    const at = before ? lines[table.end]!.to : lines[target]!.wholeFrom;
    const insert = before ? eol + prefix + newRow() : prefix + newRow() + eol;
    const cursor = at + (before ? eol.length : 0) + prefix.length + contentOffset(newRow(), col);
    return { changes: [{ from: at, to: at, insert }], selection: { from: cursor, to: cursor } };
  }
  if (command === "delete-row") {
    if (index === table.start + 1) return null;
    if (index === table.start) {
      const firstBody = lines[table.start + 2];
      if (table.end === table.start + 1 || !firstBody) {
        const from = row.wholeFrom, to = lines[table.end]!.to;
        return { changes: [{ from, to, insert: "" }], selection: { from, to: from } };
      }
      const changes = [{ from: row.from, to: row.to, insert: firstBody.text }, firstBody.ending
        ? { from: firstBody.wholeFrom, to: firstBody.end, insert: "" }
        : { from: lines[table.start + 1]!.to, to: firstBody.to, insert: "" }];
      const cursor = row.from + contentOffset(firstBody.text, col);
      return { changes, selection: { from: cursor, to: cursor } };
    }
    const change = row.ending ? { from: row.wholeFrom, to: row.end, insert: "" } : { from: lines[index - 1]!.to, to: row.to, insert: "" };
    return { changes: [change], selection: { from: change.from, to: change.from } };
  }
  if (command === "row-up" || command === "row-down") {
    if (index === table.start + 1) return null;
    let other = index + (command === "row-up" ? -1 : 1);
    if (other === table.start + 1) other += command === "row-up" ? -1 : 1;
    if (other < table.start || other > table.end) return null;
    const target = lines[other]!;
    const changes = [{ from: row.from, to: row.to, insert: target.text }, { from: target.from, to: target.to, insert: row.text }].sort((a, b) => a.from - b.from);
    const cursor = target.from + (other > index ? target.text.length - row.text.length : 0) + Math.min(selection.from - row.from, row.text.length);
    return { changes, selection: { from: cursor, to: cursor } };
  }
  if (command.startsWith("align-")) {
    const delimiter = lines[table.start + 1]!, cell = rowCells(delimiter.text)[col];
    if (!cell) return null;
    const raw = delimiter.text.slice(cell.from, cell.to), mark = raw.trim();
    const from = delimiter.from + cell.from + raw.indexOf(mark);
    const dashes = mark.replace(/:/g, "");
    const insert = (command === "align-left" || command === "align-center" ? ":" : "") + dashes + (command === "align-right" || command === "align-center" ? ":" : "");
    return changedSelection(selection, [{ from, to: from + mark.length, insert }]);
  }
  if (command === "delete-column" && count === 1) {
    const from = lines[table.start]!.wholeFrom, to = lines[table.end]!.to;
    return { changes: [{ from, to, insert: "" }], selection: { from, to: from } };
  }
  const changes = lines.slice(table.start, table.end + 1).flatMap((line, offset) => {
    const cells = rowCells(line.text), cell = cells[col];
    if (!cell) return [];
    if (command === "delete-column") {
      if (count === 2 && !line.text.trimStart().startsWith("|") && !line.text.trimEnd().endsWith("|")) {
        const remaining = cells.filter((_cell, index) => index !== col).map(cell => line.text.slice(cell.from, cell.to)).join("|");
        return [{ from: line.from, to: line.to, insert: "|" + remaining + "|" }];
      }
      const from = col === cells.length - 1 ? cell.from - 1 : cell.from;
      const to = col === cells.length - 1 ? cell.to : cell.to + 1;
      return [{ from: line.from + Math.max(0, from), to: line.from + to, insert: "" }];
    }
    const right = command === "column-right";
    const at = line.from + (right ? cell.to : cell.from);
    const content = offset === 1 ? " --- " : "  ";
    return [{ from: at, to: at, insert: right ? "|" + content + (col === cells.length - 1 && !line.text.trimEnd().endsWith("|") ? "|" : "") : (col === 0 && !line.text.trimStart().startsWith("|") ? "|" : "") + content + "|" }];
  });
  return changedSelection(selection, changes);
}

export function tableEdit(text: string, selection: SourceSelection, command: TableCommand): SourceEdit | null {
  const edit = tableEditRaw(text, selection, command);
  return edit ? preserveFinalNewline(text, edit) : null;
}

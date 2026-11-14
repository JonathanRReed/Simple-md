export interface SourceSelection { from: number; to: number }
export interface SourceChange { from: number; to: number; insert: string }
export interface SourceEdit { changes: SourceChange[]; selection: SourceSelection }
export interface SourceLine { from: number; to: number; end: number; text: string; ending: string }

export function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = text.startsWith("\uFEFF") ? 1 : 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ from, to: match.index, end: match.index + match[0].length, text: text.slice(from, match.index), ending: match[0] });
    from = match.index + match[0].length;
  }
  lines.push({ from, to: text.length, end: text.length, text: text.slice(from), ending: "" });
  return lines;
}
export function dominantEnding(text: string): string {
  const counts = new Map<string, number>([["\n", 0], ["\r\n", 0], ["\r", 0]]);
  for (const match of text.matchAll(/\r\n|\r|\n/g)) counts.set(match[0], counts.get(match[0])! + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}
export function applySourceChanges(text: string, changes: readonly SourceChange[]): string {
  for (const change of [...changes].sort((a, b) => b.from - a.from)) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  return text;
}
export function mapSourcePosition(pos: number, changes: readonly SourceChange[]): number {
  let delta = 0;
  for (const change of changes) {
    if (pos < change.from) break;
    if (pos <= change.to) return change.from + delta + change.insert.length;
    delta += change.insert.length - (change.to - change.from);
  }
  return pos + delta;
}
export function changedSelection(selection: SourceSelection, changes: SourceChange[]): SourceEdit {
  return { changes, selection: { from: mapSourcePosition(selection.from, changes), to: mapSourcePosition(selection.to, changes) } };
}

/** Deliberate insertions use the document ending and keep its final-newline state. */
export function insertSource(text: string, selection: SourceSelection, insert: string): SourceEdit {
  const eol = dominantEnding(text);
  insert = insert.replace(/\r\n|\r|\n/g, eol);
  const cursor = selection.from + insert.length;
  if (selection.to === text.length) {
    if (/[\r\n]$/.test(text) && !/[\r\n]$/.test(insert)) insert += eol;
    else if (!/[\r\n]$/.test(text)) insert = insert.replace(/[\r\n]+$/, "");
  }
  return { changes: [{ ...selection, insert }], selection: { from: Math.min(cursor, selection.from + insert.length), to: Math.min(cursor, selection.from + insert.length) } };
}

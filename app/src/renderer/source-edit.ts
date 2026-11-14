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
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  selection = { from: Math.max(bom, selection.from), to: Math.max(bom, selection.to) };
  const eol = dominantEnding(text);
  insert = insert.replace(/\r\n|\r|\n/g, eol);
  const cursor = selection.from + insert.length;
  if (selection.to === text.length) {
    if (/[\r\n]$/.test(text) && !/[\r\n]$/.test(insert)) insert += eol;
    else if (!/[\r\n]$/.test(text)) insert = insert.replace(/[\r\n]+$/, "");
  }
  return preserveFinalNewline(text, { changes: [{ ...selection, insert }], selection: { from: Math.min(cursor, selection.from + insert.length), to: Math.min(cursor, selection.from + insert.length) } });
}

/** Keep the final-newline state when a source command empties or extends the last line. */
export function preserveFinalNewline(text: string, edit: SourceEdit): SourceEdit {
  if (!edit.changes.length) return edit;
  const next = applySourceChanges(text, edit.changes), final = /[\r\n]$/.test(text);
  if (final === /[\r\n]$/.test(next)) return edit;
  const changes = edit.changes.map(change => ({ ...change }));
  let length: number;
  if (final) {
    const ending = dominantEnding(text), last = changes.at(-1)!;
    if (last.to === text.length) last.insert += ending;
    else changes.push({ from: text.length, to: text.length, insert: ending });
    length = next.length + ending.length;
  } else {
    length = next.replace(/[\r\n]+$/, "").length;
    let before = 0, after = 0, index = 0;
    for (; index < changes.length; index++) {
      const change = changes[index]!, gap = change.from - before;
      if (length <= after + gap) {
        changes.splice(index, changes.length - index, { from: before + length - after, to: text.length, insert: "" });
        break;
      }
      after += gap;
      if (length < after + change.insert.length) {
        change.insert = change.insert.slice(0, length - after); change.to = text.length;
        changes.splice(index + 1); break;
      }
      after += change.insert.length; before = change.to;
    }
    if (index === changes.length) changes.push({ from: before + length - after, to: text.length, insert: "" });
  }
  return { changes, selection: { from: Math.min(edit.selection.from, length), to: Math.min(edit.selection.to, length) } };
}

import { ChangeSet, EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

export type FormatKind = "bold" | "italic" | "code" | "strike" | "link";
const marks: Record<Exclude<FormatKind, "link">, string> = { bold: "**", italic: "*", code: "`", strike: "~~" };

/** Inline commands preserve selected bytes, including mixed line endings. */
export function inlineTransaction(state: EditorState, kind: FormatKind): TransactionSpec | null {
  if (state.readOnly) return null;
  const edit = state.changeByRange(range => {
    const from = range.from;
    let to = range.to;
    while (to > from && state.sliceDoc(to - 1, to) === "\n") to--;
    if (!range.empty && to === from) return { changes: [], range };
    if (kind === "link") {
      const url = from + (to - from) + 3;
      return { changes: [{ from, insert: "[" }, { from: to, insert: "](url)" }], range: EditorSelection.range(url, url + 3) };
    }
    const mark = marks[kind], len = mark.length, text = state.sliceDoc(from, to);
    if (state.sliceDoc(from - len, from) === mark && state.sliceDoc(to, to + len) === mark) {
      return { changes: [{ from: from - len, to: from }, { from: to, to: to + len }], range: EditorSelection.range(from - len, to - len) };
    }
    if (text.length >= len * 2 && text.startsWith(mark) && text.endsWith(mark)) {
      return { changes: [{ from, to: from + len }, { from: to - len, to }], range: EditorSelection.range(from, to - len * 2) };
    }
    return { changes: [{ from, insert: mark }, { from: to, insert: mark }], range: EditorSelection.range(from + len, to + len) };
  });
  if (edit.changes.empty) return null;
  let changes = edit.changes, selection = edit.selection;
  const next = changes.apply(state.doc);
  const final = state.doc.lines > 1 && state.doc.line(state.doc.lines).length === 0;
  const nextFinal = next.lines > 1 && next.line(next.lines).length === 0;
  if (final !== nextFinal) {
    let line = next.lines;
    while (line > 1 && next.line(line).length === 0) line--;
    const ending = final ? ChangeSet.of({ from: next.length, insert: "\n" }, next.length)
      : ChangeSet.of({ from: next.line(line).to, to: next.length }, next.length);
    changes = changes.compose(ending); selection = selection.map(ending);
  }
  return { changes, selection, annotations: isolateHistory.of("full"), userEvent: "input.format" };
}

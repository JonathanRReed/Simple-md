import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { byteText, parseByteText, restoreByteText } from "./byte-text.js";
import { editorText } from "./editor-text.js";
import { applySourceChanges, preserveFinalNewline, type SourceEdit, type SourceSelection } from "./source-edit.js";

export function sourcePosition(state: EditorState, position: number): number {
  const value = state.field(editorText), line = state.doc.lineAt(position).number;
  return position + state.field(byteText).bom.length + value.offsets.line(line).from - (line - 1);
}
export function sourceSelection(state: EditorState): SourceSelection {
  const range = state.selection.main;
  return { from: sourcePosition(state, range.from), to: sourcePosition(state, range.to) };
}
// Call in source order. Each source byte is visited at most once.
function normalizedPositions(text: string) {
  let at = text.startsWith("\uFEFF") ? 1 : 0, removed = at;
  return (position: number) => {
    while (at < position) {
      if (text[at] === "\n" && text[at - 1] === "\r") removed++;
      at++;
    }
    return Math.max(0, position - removed);
  };
}
export function sourceTransaction(state: EditorState, edit: SourceEdit | null): TransactionSpec | null {
  if (!edit || !edit.changes.length || state.readOnly) return null;
  const source = state.field(editorText).text;
  edit = preserveFinalNewline(source, edit);
  const next = applySourceChanges(source, edit.changes);
  if (next === source) return null;
  const normalized = parseByteText(next);
  const sourceAt = normalizedPositions(source), nextAt = normalizedPositions(next);
  return {
    changes: edit.changes.map(change => ({ from: sourceAt(change.from), to: sourceAt(change.to), insert: parseByteText(change.insert).text })),
    selection: EditorSelection.range(nextAt(edit.selection.from), nextAt(edit.selection.to)),
    effects: restoreByteText.of(normalized.format),
    annotations: isolateHistory.of("full"),
    userEvent: "input.format",
    scrollIntoView: true,
  };
}

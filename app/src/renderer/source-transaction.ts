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
const normalizedPosition = (text: string, position: number) => parseByteText(text.slice(0, position)).text.length;
export function sourceTransaction(state: EditorState, edit: SourceEdit | null): TransactionSpec | null {
  if (!edit || !edit.changes.length || state.readOnly) return null;
  const source = state.field(editorText).text;
  edit = preserveFinalNewline(source, edit);
  const next = applySourceChanges(source, edit.changes);
  if (next === source) return null;
  const normalized = parseByteText(next);
  return {
    changes: edit.changes.map(change => ({ from: normalizedPosition(source, change.from), to: normalizedPosition(source, change.to), insert: parseByteText(change.insert).text })),
    selection: EditorSelection.range(normalizedPosition(next, edit.selection.from), normalizedPosition(next, edit.selection.to)),
    effects: restoreByteText.of(normalized.format),
    annotations: isolateHistory.of("full"),
    userEvent: "input.format",
    scrollIntoView: true,
  };
}

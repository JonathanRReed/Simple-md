import { EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

export function spellingReplacement(state: EditorState, range: { from: number; to: number }, word: string, replacement: string): TransactionSpec | null {
  if (state.readOnly || range.from < 0 || range.to > state.doc.length || state.sliceDoc(range.from, range.to) !== word || !replacement || /[\r\n]/.test(replacement)) return null;
  return { changes: { ...range, insert: replacement }, userEvent: "input.replace", annotations: isolateHistory.of("full") };
}

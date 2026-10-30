import { EditorState } from "@codemirror/state";
import { history, historyField, redoDepth, undoDepth } from "@codemirror/commands";
import { byteText } from "./byte-text.js";

// A depth estimate avoids serializing changes and whole-document text on tab switches.
const ESTIMATED_EVENT_BYTES = 20_000;
const HISTORY_BUDGET_BYTES = 2_000_000;
export const MAX_HISTORY_DEPTH = HISTORY_BUDGET_BYTES / ESTIMATED_EVENT_BYTES;

export function retainEditorState(state: EditorState): EditorState {
  let retained = state.field(historyField);
  const estimatedBytes = (undoDepth(state) + redoDepth(state)) * ESTIMATED_EVENT_BYTES;
  if (estimatedBytes > HISTORY_BUDGET_BYTES) {
    // CodeMirror exposes the history field as unknown. Preserve its prototype and
    // event objects, including byte-format effects that JSON history drops.
    if (!retained || typeof retained !== "object" || !("done" in retained) || !Array.isArray(retained.done) || !("undone" in retained) || !Array.isArray(retained.undone)) throw new Error("Unsupported CodeMirror history state.");
    const redoLimit = Math.min(retained.undone.length, Math.floor(MAX_HISTORY_DEPTH / 2));
    retained = Object.assign(Object.create(Object.getPrototypeOf(retained)), retained, {
      done: retained.done.slice(-Math.max(1, MAX_HISTORY_DEPTH - redoLimit)),
      undone: redoLimit ? retained.undone.slice(-redoLimit) : [],
    });
  }
  const savedBytes = state.field(byteText);
  return EditorState.create({
    doc: state.doc, selection: state.selection,
    extensions: [history({ minDepth: MAX_HISTORY_DEPTH }), byteText.init(() => savedBytes), historyField.init(() => retained)],
  });
}

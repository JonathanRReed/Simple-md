import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { history, isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import { byteText, exactText, parseByteText } from "../src/renderer/byte-text";
import { retainEditorState, MAX_HISTORY_DEPTH } from "../src/renderer/editor-history";

function initial(text: string) {
  const parsed = parseByteText(text);
  return EditorState.create({ doc: parsed.text, extensions: [history({ minDepth: 300 }), byteText.init(() => parsed.format)] });
}
test("tab snapshots retain history and byte format without serializing the document", () => {
  let state = initial("\uFEFFone\r\ntwo\rthree\n");
  state = state.update({ changes: { from: 0, insert: "x" } }).state;
  state.toJSON = () => { throw new Error("Snapshot serialized the document"); };
  let restored = retainEditorState(state);
  expect(restored.doc).toBe(state.doc);
  const target = { get state() { return restored; }, dispatch(tr: import("@codemirror/state").Transaction) { restored = tr.state; } };
  expect(undo(target)).toBe(true); expect(exactText(restored)).toBe("\uFEFFone\r\ntwo\rthree\n");
  expect(redo(target)).toBe(true); expect(exactText(restored)).toBe(exactText(state));
});
test("large histories keep the newest events instead of losing every undo", () => {
  let state = initial("\uFEFFstart\r\n");
  const chunk = "x".repeat(25_000);
  for (let i = 0; i < MAX_HISTORY_DEPTH + 30; i++) state = state.update({ changes: { from: state.doc.length, insert: chunk }, annotations: isolateHistory.of("full") }).state;
  let restored = retainEditorState(state);
  expect(undoDepth(restored)).toBe(MAX_HISTORY_DEPTH);
  const target = { get state() { return restored; }, dispatch(tr: import("@codemirror/state").Transaction) { restored = tr.state; } };
  for (let i = 0; i < MAX_HISTORY_DEPTH; i++) expect(undo(target)).toBe(true);
  expect(undo(target)).toBe(false);
  expect(exactText(restored)).toBe("\uFEFFstart\r\n" + chunk.repeat(30));
  expect(redo(target)).toBe(true);
});
test("history containing a multi-megabyte deletion keeps undo and redo", () => {
  const original = "\uFEFFstart\r\n" + "x".repeat(2_100_000);
  let state = initial(original);
  state = state.update({ changes: { from: 6, to: state.doc.length }, annotations: isolateHistory.of("full") }).state;
  let restored = retainEditorState(state);
  expect(undoDepth(restored)).toBe(1);
  const target = { get state() { return restored; }, dispatch(tr: import("@codemirror/state").Transaction) { restored = tr.state; } };
  expect(undo(target)).toBe(true); expect(exactText(restored)).toBe(original);
  expect(redo(target)).toBe(true); expect(exactText(restored)).toBe(exactText(state));
});

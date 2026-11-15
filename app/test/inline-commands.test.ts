import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";
import { inlineTransaction, type FormatKind } from "../src/renderer/inline-commands";
import { byteText, parseByteText, exactText } from "../src/renderer/byte-text";
import { editorText } from "../src/renderer/editor-text";
function stateFor(text: string, anchor = 0, head?: number) {
  const parsed = parseByteText(text);
  return EditorState.create({ doc: parsed.text, selection: { anchor, head: head ?? parsed.text.length }, extensions: [history(), byteText.init(() => parsed.format), editorText] });
}
for (const [kind, mark] of [["bold", "**"], ["italic", "*"], ["strike", "~~"], ["code", "`"]] satisfies [FormatKind, string][]) {
  for (const ending of ["", "\n", "\r\n"]) test(`${kind} preserves final newline ${JSON.stringify(ending)}`, () => {
    let state = stateFor(`Hello${ending}`);
    state = state.update(inlineTransaction(state, kind)!).state;
    expect(exactText(state)).toBe(`${mark}Hello${mark}${ending}`);
    expect(undoDepth(state)).toBe(1);
    undo({ state, dispatch(tr) { state = tr.state; } });
    expect(exactText(state)).toBe(`Hello${ending}`);
  });
}
test("link insertion keeps selected mixed endings and selects its URL", () => {
  let state = stateFor("\uFEFFone\r\ntwo\nlast");
  state = state.update(inlineTransaction(state, "link")!).state;
  expect(exactText(state)).toBe("\uFEFF[one\r\ntwo\nlast](url)");
  expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("url");
});
test("empty inline insertions and removals retain the final-newline state", () => {
  let state = stateFor("Hello\r\n", 6, 6);
  state = state.update(inlineTransaction(state, "bold")!).state;
  expect(exactText(state)).toBe("Hello\r\n****\r\n");
  state = stateFor("Hello\r\n****", 8, 8);
  state = state.update(inlineTransaction(state, "bold")!).state;
  expect(exactText(state)).toBe("Hello");
});
test("inline commands leave read-only state and newline-only selections alone", () => {
  expect(inlineTransaction(stateFor("\n"), "bold")).toBeNull();
  const parsed = parseByteText("Hello");
  const state = EditorState.create({ doc: parsed.text, extensions: [byteText.init(() => parsed.format), editorText, EditorState.readOnly.of(true)] });
  for (const kind of ["bold", "italic", "strike", "code", "link"] satisfies FormatKind[]) expect(inlineTransaction(state, kind)).toBeNull();
});

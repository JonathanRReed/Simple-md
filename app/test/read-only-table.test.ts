import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { EditorView } from "@codemirror/view";
import { moveCell } from "../src/renderer/tables";
test("table Tab leaves a read-only buffer and its selection untouched", () => {
  const text = '| A | B |\n| --- | --- |\n| one | two |';
  let state = EditorState.create({ doc: text, selection: { anchor: text.indexOf('two') }, extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(true)] });
  ensureSyntaxTree(state, text.length, 1000);
  const initial = state;
  moveCell({ get state() { return state; }, dispatch(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state; } } as unknown as EditorView, 1);
  expect(state.doc.toString()).toBe(text);
  expect(state.selection.eq(initial.selection)).toBe(true);
});

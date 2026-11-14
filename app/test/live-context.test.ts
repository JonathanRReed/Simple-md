import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { createRenderCore } from "../src/shared/render-core";
import { referenceContext } from "../src/renderer/reference-context";
import { cellSourceOffset, moveCell } from "../src/renderer/tables";
import type { EditorView } from "@codemirror/view";

const source = '![Logo][logo]\n\n| Link |\n| --- |\n| [Site][site] |\n\n[logo]: ./logo.png\n  "Logo title"\n[site]: https://example.com\n\nEnd';
function stateFor(text: string) { return EditorState.create({ doc: text, extensions: markdown({ base: markdownLanguage }) }); }
test("image and table fragments use document reference definitions, including titles", async () => {
  let state = stateFor(source);
  const core = createRenderCore();
  const refs = referenceContext(state, ensureSyntaxTree(state, state.doc.length, 1000)!);
  expect((await core.renderFragment('![Logo][logo]\n\n' + refs, undefined)).html).toContain('title="Logo title"');
  expect((await core.renderFragment('| Link |\n| --- |\n| [Site][site] |\n\n' + refs, undefined)).html).toContain('href="https://example.com"');
  const from = source.indexOf("example.com");
  state = state.update({ changes: { from, to: from + 11, insert: "changed.test" } }).state;
  const changed = referenceContext(state, ensureSyntaxTree(state, state.doc.length, 1000)!);
  expect(changed).not.toBe(refs);
  expect((await core.renderFragment('| Link |\n| --- |\n| [Site][site] |\n\n' + changed, undefined)).html).toContain('href="https://changed.test"');
});
test("table Tab never changes a read-only buffer", () => {
  const text = '| A | B |\n| --- | --- |\n| one | two |';
  const state = EditorState.create({ doc: text, selection: { anchor: text.indexOf("two") }, extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(true)] });
  ensureSyntaxTree(state, text.length, 1000);
  let dispatched = false;
  expect(moveCell({ state, dispatch() { dispatched = true; } } as unknown as EditorView, 1)).toBe(false);
  expect(dispatched).toBe(false);
});
test("table cell clicks map header and body columns, skipping the delimiter row", () => {
  for (const text of ['| A | B |\n| --- | --- |\n| one \\| more | two |', 'A | B\n--- | ---\none | two']) {
    expect(text.slice(cellSourceOffset(text, 0, 1))).toStartWith("B");
    expect(text.slice(cellSourceOffset(text, 1, 0))).toStartWith("one");
    expect(text.slice(cellSourceOffset(text, 1, 1))).toStartWith("two");
  }
});

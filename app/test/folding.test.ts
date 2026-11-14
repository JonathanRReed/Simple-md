import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldedRanges, ensureSyntaxTree } from "@codemirror/language";
import { SearchQuery, findNext, search, setSearchQuery } from "@codemirror/search";
import { writingFolding, runFold } from "../src/renderer/folding";
function editor(text: string, at = 0) {
  let state = EditorState.create({ doc: text, selection: { anchor: at }, extensions: [markdown({ base: markdownLanguage }), writingFolding, search()] });
  ensureSyntaxTree(state, text.length, 1000);
  const view = { plugin() { return null; }, lineBlockAt(pos: number) { return state.doc.lineAt(pos); }, get state() { return state; }, dispatch(spec: Parameters<EditorState["update"]>[0]) { state = state.update(spec).state; } } as unknown as EditorView;
  return view;
}
test("fold from the middle of a heading section and unfold without source edits", () => {
  const text = "# First\n\nOne\n\n## Nested\n\nTwo\n\n# Next\n\nThree";
  const view = editor(text, text.indexOf("One"));
  runFold(view, "fold");
  const fold = foldedRanges(view.state).iter();
  expect(fold.from).toBe(7); expect(fold.to).toBe(text.indexOf("# Next") - 1);
  expect(view.state.doc.toString()).toBe(text);
  runFold(view, "unfold"); expect(foldedRanges(view.state).size).toBe(0);
});
test("code fences and frontmatter fold at a cursor inside them", () => {
  for (const [text, at] of [["---\ntitle: Test\n---\n\nBody", 8], ["~~~ts\nconst x = 1\n~~~\n\nBody", 10]] satisfies [string, number][]) {
    const view = editor(text, at); runFold(view, "fold");
    expect(foldedRanges(view.state).size).toBe(1);
    runFold(view, "unfold-all"); expect(foldedRanges(view.state).size).toBe(0);
    expect(view.state.doc.toString()).toBe(text);
  }
});
test("Fold All Sections preserves text and Find reveals its selected match", () => {
  const text = "---\ntitle: Ignore\n---\n\n# First\n\nFind this\n\n# Last\n\nEnd";
  const view = editor(text); runFold(view, "fold-all");
  expect(foldedRanges(view.state).size).toBe(3);
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "Find this" })) });
  expect(findNext(view)).toBe(true);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("Find this");
  expect(foldedRanges(view.state).size).toBe(2);
  expect(view.state.doc.toString()).toBe(text);
});
test("editing before an untouched frontmatter fold maps its closing range", () => {
  const view = editor("---\ntitle: Test\n---\n\nBody", 8);
  view.dispatch({ changes: { from: 8, insert: "More " } });
  runFold(view, "fold");
  expect(foldedRanges(view.state).iter().to).toBe(24);
});

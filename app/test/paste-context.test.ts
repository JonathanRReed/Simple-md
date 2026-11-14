import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { canPasteLink } from "../src/renderer/paste-context";
import { mdxSyntax } from "../src/renderer/mdx-syntax";
import { findMdxRanges } from "../src/shared/mdx-ranges";

const editor = await Bun.file(new URL("../src/renderer/editor.ts", import.meta.url)).text();
const pasteSource = editor.slice(editor.indexOf("          paste(event, v) {"), editor.indexOf("          drop(event, v) {"));
const paste = new Function("IMAGE_TYPES", "importImages", "canPasteLink", `return ({${pasteSource}}).paste;`)(/^image\//, () => { throw new Error("Unexpected image"); }, canPasteLink);

for (const [name, text, allowed] of [
  ["prose", "Replace old text", true],
  ["fence", '```js\nconst url = "old";\n```', false],
  ["inline code", "Use `old` here", false],
  ["destination", "[label](https://old.test)", false],
  ["frontmatter", "---\ntitle: old\n---\nText", false],
  ["JSX", '<Card title="old" />', false],
  ["expression", "Value {old}", false],
  ["ESM", 'import old from "module"', false],
] as const) test(`URL paste respects ${name}`, () => {
  const from = text.indexOf("old");
  const state = EditorState.create({ doc: text, selection: { anchor: from, head: from + 3 }, extensions: [markdown({ base: markdownLanguage }), mdxSyntax(findMdxRanges(text))] });
  expect(canPasteLink(state)).toBe(allowed);
  let pasted = state;
  const handled = paste({ clipboardData: { files: [], getData: () => "https://example.test" }, preventDefault() {} }, {
    get state() { return pasted; }, dispatch(spec: Parameters<EditorState["update"]>[0]) { pasted = pasted.update(spec).state; },
  });
  expect(handled).toBe(allowed);
  if (!handled) pasted = pasted.update({ changes: { from, to: from + 3, insert: "https://example.test" } }).state;
  expect(pasted.doc.toString()).toBe(text.slice(0, from) + (allowed ? "[old](https://example.test)" : "https://example.test") + text.slice(from + 3));
});

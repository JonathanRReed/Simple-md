import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { createRenderCore } from "../src/shared/render-core";
import { mdxSyntax } from "../src/renderer/mdx-syntax";
import { findMdxRanges } from "../src/shared/mdx-ranges";

// State/decorations only. No DOM, browser, clipboard or Electron is started.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
const { buildLiveDecorations, liveDecorationField } = await import("../src/renderer/live");
if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
else Reflect.deleteProperty(globalThis, "window");
const core = createRenderCore();
const host = { baseUrl: () => null, openLink() {}, renderFragment: (text: string) => core.renderFragment(text, undefined) };
function stateFor(text: string, mdx = true) {
  const state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [markdown({ base: markdownLanguage }), ...(mdx ? [mdxSyntax(findMdxRanges(text))] : [])] });
  ensureSyntaxTree(state, text.length, 1000);
  return state;
}
function widgets(decorations: ReturnType<typeof buildLiveDecorations>) {
  const values: { from: number; to: number; widget: { kind?: string; source?: string; tex?: string; references?: string; eq(other: unknown): boolean } }[] = [];
  for (const cursor = decorations.iter(); cursor.value; cursor.next()) if (cursor.value.spec.widget) values.push({ from: cursor.from, to: cursor.to, widget: cursor.value.spec.widget });
  return values;
}
test("real Live widgets carry reference context and invalidate on a distant definition edit", () => {
  const source = '![Logo][logo]\n\n| Link |\n| --- |\n| [Site][site] |\n\n' + 'filler\n\n'.repeat(40) + '[logo]: ./old.png\n[site]: https://old.test\n\nEnd';
  const field = liveDecorationField(host);
  let state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [markdown({ base: markdownLanguage }), field] });
  const before = widgets(state.field(field).decorations).filter(item => ['image', 'table'].includes(item.widget.kind ?? ''));
  expect(before).toHaveLength(2);
  for (const { widget } of before) expect(widget.references).toContain('./old.png');
  state = state.update({ changes: [...source.matchAll(/old/g)].map(match => ({ from: match.index, to: match.index + 3, insert: 'new' })) }).state;
  const after = widgets(state.field(field).decorations).filter(item => ['image', 'table'].includes(item.widget.kind ?? ''));
  expect(after).toHaveLength(2);
  after.forEach(({ widget }, i) => { expect(widget.references).toContain('./new.png'); expect(widget.eq(before[i]!.widget)).toBe(false); });
});
test("real Live math widgets use Read extraction and reject code, metadata, destinations and MDX", () => {
  for (const raw of ['$x^2$', '$`x^2`$', '$$x^2$$', '$`\\sqrt{\\$4}`$']) {
    const state = stateFor(`Before ${raw} after\n\nEnd`);
    const math = widgets(buildLiveDecorations(state, host)).filter(item => item.widget.tex !== undefined);
    expect(math.map(item => item.widget.tex)).toEqual([raw.includes('sqrt') ? '\\sqrt{\\$4}' : 'x^2']);
  }
  for (const text of ['`$x$`\n\nEnd', '```js\n$x$\n```\n\nEnd', '---\ntitle: $x$\n---\n\nEnd', '[Link](https://test/$x$)\n\nEnd', '<Card>{$x$}</Card>\n\nEnd']) {
    expect(widgets(buildLiveDecorations(stateFor(text), host)).filter(item => item.widget.tex !== undefined)).toEqual([]);
  }
});

test("plain Markdown HTML code excludes Live math, including multiline code elements", () => {
  for (const text of ['Before <code>$x$</code> after\n\nEnd', 'Before <code>\n$x$\n</code> after\n\nEnd']) expect(widgets(buildLiveDecorations(stateFor(text, false), host)).filter(item => item.widget.tex !== undefined)).toEqual([]);
});

test("moving a document invalidates Live resource URLs without changing source", () => {
  const state = stateFor('![Logo](./logo.png)\n\nEnd');
  let base = 'file:///old/';
  const changingHost = { ...host, baseUrl: () => base };
  const [before] = widgets(buildLiveDecorations(state, changingHost));
  base = 'file:///new/';
  const [after] = widgets(buildLiveDecorations(state, changingHost));
  expect(after!.widget.eq(before!.widget)).toBe(false);
});

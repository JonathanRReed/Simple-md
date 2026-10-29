import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateContext, contextTemplate, type ContextActions } from "../src/main/context-menu";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { spellingReplacement } from "../src/renderer/spelling";
import { byteText, parseByteText } from "../src/renderer/byte-text";
import { editorText } from "../src/renderer/editor-text";

const empty = { selectionPresent: false, editable: false, linkURL: "", imageURL: "", misspelledWord: "", suggestions: [] };
const noop = () => {};
const actions: ContextActions = { replace: noop, dictionary: noop, open: noop, copy: noop, reveal: noop, lookup: noop };
test("context validation rejects unsafe protocols, traversal and symlink escapes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-context-"));
  try {
    const inside = path.join(root, "inside"); fs.mkdirSync(inside);
    const file = path.join(inside, "sibling.md"); fs.writeFileSync(file, "ok");
    const outside = path.join(root, "outside.md"); fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(inside, "escape.md"));
    const urls = { baseUrl: pathToFileURL(inside + path.sep).href };
    expect(await validateContext({ ...empty, linkURL: pathToFileURL(file).href }, urls)).toEqual({ ...empty, linkURL: pathToFileURL(file).href });
    for (const linkURL of ["javascript:alert(1)", "data:text/html,evil", "https://ok/\u0000", pathToFileURL(outside).href, pathToFileURL(path.join(inside, "escape.md")).href, urls.baseUrl + "%2e%2e/outside.md", urls.baseUrl + "a%2f..%2foutside.md"]) {
      await expect(validateContext({ ...empty, linkURL }, urls)).rejects.toThrow();
      await expect(validateContext({ ...empty, imageURL: linkURL }, urls)).rejects.toThrow();
    }
    for (const input of [null, {}, { ...empty, editable: 1 }, { ...empty, suggestions: [1] }, { ...empty, suggestions: Array(33).fill("word") }]) await expect(validateContext(input, urls)).rejects.toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("native templates contain link, image, editor and spelling actions", () => {
  const link = contextTemplate({ ...empty, linkURL: "file:///notes/sibling.md" }, actions);
  expect(link.map(i => i.label)).toContain("Open in New Tab");
  const image = contextTemplate({ ...empty, imageURL: "file:///notes/picture.png" }, actions, "win32");
  expect(image.map(i => i.label)).toContain("Reveal in Explorer");
  const spelling = contextTemplate({ ...empty, editable: true, misspelledWord: "wrod", suggestions: ["word"] }, actions);
  expect(spelling.map(i => i.label)).toContain("word");
  expect(spelling.map(i => i.label)).toContain("Add to Dictionary");
  expect(spelling.map(i => i.role)).toEqual(expect.arrayContaining(["cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]));
  expect(contextTemplate(empty, actions).map(i => i.role)).toEqual(["copy", "selectAll"]);
  expect(contextTemplate(empty, { ...actions, share: noop }, "darwin").map(i => i.label)).toContain("Share");
  for (const platform of ["win32", "linux"]) expect(contextTemplate({ ...empty, selectionPresent: true }, { ...actions, share: noop }, platform).map(i => i.label)).not.toContain("Share");
});
test("spelling replacement and undo preserve BOM and mixed line endings", () => {
  const source = "\ufeff# Title\r\nwrod 😀\rtrailing  \nlast\r\n";
  const parsed = parseByteText(source);
  let state = EditorState.create({ doc: parsed.text, extensions: [history(), byteText.init(() => parsed.format), editorText] });
  const from = state.doc.toString().indexOf("wrod");
  const range = { from, to: from + 4 };
  const replacement = spellingReplacement(state, range, "wrod", "word");
  expect(replacement).not.toBeNull(); state = state.update(replacement!).state;
  expect(Buffer.from(state.field(editorText).text)).toEqual(Buffer.from(source.replace("wrod", "word")));
  undo({ get state() { return state; }, dispatch(tr) { state = tr.state; } });
  expect(Buffer.from(state.field(editorText).text)).toEqual(Buffer.from(source));
  expect(spellingReplacement(state, range, "stale", "word")).toBeNull();
});

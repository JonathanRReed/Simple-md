import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { history, undo, redo, undoDepth } from "@codemirror/commands";
import { byteText, exactText, parseByteText } from "../src/renderer/byte-text";
import { editorText } from "../src/renderer/editor-text";
import { sourceTransaction, sourceSelection } from "../src/renderer/source-transaction";
import { blockEdit, type BlockCommand } from "../src/renderer/block-commands";
import { applySourceChanges, insertSource, type SourceEdit } from "../src/renderer/source-edit";

function result(text: string, command: BlockCommand, from = 0, to = text.length) {
  const edit = blockEdit(text, { from, to }, command);
  return { text: applySourceChanges(text, edit.changes), selection: edit.selection };
}
for (const ending of ["\n", "\r\n", "\r"]) for (const final of ["", ending]) {
  for (let level = 1; level <= 6; level++) test(`heading ${level}, ${JSON.stringify(ending)}, final ${!!final}`, () => {
    const command: BlockCommand = `heading-${level as 1 | 2 | 3 | 4 | 5 | 6}`;
    const source = `> Title${ending}> Other${final}`;
    const formatted = result(source, command, 2, 7);
    expect(formatted.text).toBe(`> ${"#".repeat(level)} Title${ending}> Other${final}`);
    expect(result(formatted.text, command, formatted.selection.from, formatted.selection.to).text).toBe(source);
  });
  test(`lists preserve quote, indentation, ending and outside numbering ${JSON.stringify(ending)} ${!!final}`, () => {
    const source = `9. Outside${ending}>   one${ending}>   two${ending}8. Outside${final}`;
    const from = source.indexOf("one"), to = source.indexOf("8. Outside");
    expect(result(source, "number-list", from, to).text).toBe(`9. Outside${ending}>   1. one${ending}>   2. two${ending}8. Outside${final}`);
    for (const command of ["bullet-list", "task-list"] satisfies BlockCommand[]) {
      const formatted = result(source, command, from, to);
      expect(result(formatted.text, command, formatted.selection.from, formatted.selection.to).text).toBe(source);
    }
  });
  test(`task changes only marker bytes ${JSON.stringify(ending)} ${!!final}`, () => {
    const source = `> - [ ] one${ending}  2. [X] two${ending}ordinary [ ] prose${final}`;
    expect(result(source, "toggle-task").text).toBe(`> - [x] one${ending}  2. [ ] two${ending}ordinary [ ] prose${final}`);
  });
  test(`footnotes retain labels, endings, final newline ${JSON.stringify(ending)} ${!!final}`, () => {
    const source = `Hello[^2]${ending}${ending}[^2]: Existing${final}`;
    const next = result(source, "footnote", 5, 5);
    expect(next.text).toBe(`Hello[^1][^2]${ending}${ending}[^2]: Existing${ending}${ending}[^1]: ${final}`);
    expect(next.text.slice(next.selection.from)).toBe(final);
    expect(next.selection.from).toBe(next.selection.to);
  });
}
test("body and quote toggles retain other source", () => {
  expect(result("  > ## Heading\n\n<Card value={1} />", "body", 7, 7).text).toBe("  > Heading\n\n<Card value={1} />");
  expect(result("> first\n> > nested", "quote").text).toBe("first\n> nested");
  expect(result("first\nsecond", "quote").text).toBe("> first\n> second");
});
test("code fence exceeds embedded runs and puts caret at language", () => {
  const text = "one ``` and ````\r\ntwo";
  const next = result(text, "code-block");
  expect(next.text).toBe("`````\r\none ``` and ````\r\ntwo\r\n`````");
  expect(next.selection).toEqual({ from: 5, to: 5 });
  expect(result(next.text, "code-block").text).toBe(text);
  expect(result("", "code-block").text).toBe("```\n\n```");
  expect(result("```\n```", "code-block").text).toBe("");
});
test("rule toggle and insertion do not add a final newline", () => {
  expect(result("text", "rule", 2, 2).text).toBe("text\n\n---");
  for (const rule of ["---", "****", "_ _ _", "- - -"]) expect(result(`${rule}\r\nnext`, "rule", 0, 0).text).toBe("\r\nnext");
});
test("empty and EOF footnotes remain separated from their reference", () => {
  expect(result("", "footnote").text).toBe("[^1]\n\n[^1]: ");
  expect(result("A\n", "footnote", 2, 2).text).toBe("A\n[^1]\n\n[^1]: \n");
});
test("commands are one undo step and retain BOM and mixed endings through redo", () => {
  const text = "\uFEFFone\r\ntwo\nthree\rfour";
  const parsed = parseByteText(text);
  let state = EditorState.create({ doc: parsed.text, selection: { anchor: 0, head: parsed.text.length }, extensions: [history(), byteText.init(() => parsed.format), editorText] });
  const edit = blockEdit(text, sourceSelection(state), "number-list");
  const spec = sourceTransaction(state, edit)!;
  state = state.update(spec).state;
  expect(exactText(state)).toBe("\uFEFF1. one\r\n2. two\n3. three\r4. four");
  const dispatch = (tr: Parameters<typeof state.update>[0]) => { state = state.update(tr).state; };
  expect(undo({ get state() { return state; }, dispatch })).toBe(true);
  expect(exactText(state)).toBe(text);
  expect(redo({ get state() { return state; }, dispatch })).toBe(true);
  expect(exactText(state)).toBe(applySourceChanges(text, edit.changes));
});
test("read-only rejects every source command", () => {
  const state = EditorState.create({ doc: "source", extensions: [byteText, editorText, EditorState.readOnly.of(true)] });
  const edit: SourceEdit = { changes: [{ from: 0, to: 6, insert: "changed" }], selection: { from: 0, to: 0 } };
  expect(sourceTransaction(state, edit)).toBeNull();
});

test("image and HTML insertions preserve dominant endings and final newline state", () => {
  for (const text of ["draft", "draft\r\n", "\uFEFFdraft\n"]) {
    const result = insertSource(text, { from: text.length, to: text.length }, "![image](assets/image.png)\nsecond");
    const next = applySourceChanges(text, result.changes);
    expect(/[\r\n]$/.test(next)).toBe(/[\r\n]$/.test(text));
    expect(next).toContain(text.includes("\r\n") ? "png)\r\nsecond" : "png)\nsecond");
  }
});

test("task toggling ignores code, frontmatter, imports and JSX attributes", () => {
  const text = '---\ntext: "- [ ] metadata"\n---\n\n```\n- [ ] code\n```\n\nimport X from "x";\n\n<Card title="- [ ] attribute">\n\n- [ ] prose\n\n</Card>';
  const edit = blockEdit(text, { from: 0, to: text.length }, "toggle-task", true);
  expect(applySourceChanges(text, edit.changes)).toBe(text.replace("- [ ] prose", "- [x] prose"));
});

test("a footnote after a selected phrase keeps the phrase intact", () => {
  expect(result("Selected words.", "footnote", 0, 14).text).toBe("Selected words[^1].\n\n[^1]: ");
});

test("Body on plain prose does not create an undo step", () => {
  let state = EditorState.create({ doc: "Plain prose", extensions: [history(), byteText, editorText] });
  const edit = blockEdit("Plain prose", { from: 0, to: 0 }, "body");
  const spec = sourceTransaction(state, edit);
  if (spec) state = state.update(spec).state;
  expect(exactText(state)).toBe("Plain prose");
  expect(undoDepth(state)).toBe(0);
});

test("task toggling leaves an incomplete MDX expression alone", () => {
  const text = "- [ ] Actual\n\n{items.map(() => {\n- [ ] Literal";
  const edit = blockEdit(text, { from: 0, to: text.length }, "toggle-task", true);
  expect(applySourceChanges(text, edit.changes)).toBe(text.replace("[ ] Actual", "[x] Actual"));
});

for (const eol of ["\n", "\r\n"]) test(`empty last blocks preserve a missing final newline ${JSON.stringify(eol)}`, () => {
  expect(result(`Intro${eol}---`, "rule", 5 + eol.length, 5 + eol.length).text).toBe("Intro");
  expect(result(`Intro${eol}# `, "body", 5 + eol.length, 5 + eol.length).text).toBe("Intro");
  expect(result(`Intro${eol}#`, "heading-1", 5 + eol.length, 5 + eol.length).text).toBe("Intro");
  expect(result(`Intro${eol}\`\`\`${eol}\`\`\``, "code-block", 5 + eol.length).text).toBe("Intro");
});

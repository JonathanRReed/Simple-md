import { expect, test } from "bun:test";
import { history, redo, undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import fs from "node:fs/promises";
import path from "node:path";
import { byteText, exactText, parseByteText, restoreByteText } from "../src/renderer/byte-text";
import { decodeDocument } from "../src/main/files";

const fixtures = path.join(import.meta.dir, "fixtures/bytes");

function editor(source: string) {
  const parsed = parseByteText(source);
  const target = {
    state: EditorState.create({ doc: parsed.text, extensions: [history(), byteText.init(() => parsed.format)] }),
    dispatch(tr: Transaction) { target.state = tr.state; },
  };
  const edit = (from: number, to: number, insert: string) => {
    target.state = target.state.update({ changes: { from, to, insert }, userEvent: "input.type" }).state;
  };
  return { target, edit, text: () => exactText(target.state) };
}

for (const name of ["lf", "crlf", "cr", "mixed", "bom-crlf", "no-final-newline", "astral", "binary-looking", "irregular-table"]) {
  test(`${name}: opening and editing one line preserves every other byte; undo and redo restore bytes`, async () => {
    const original = await fs.readFile(path.join(fixtures, `${name}.md`));
    const decoded = decodeDocument(original);
    expect(decoded.readOnlyReason).toBeUndefined();
    const ed = editor(decoded.text);
    expect(Buffer.from(ed.text())).toEqual(original);
    const from = ed.target.state.doc.line(2).from;
    ed.edit(from, from, "edited ");
    const sourceAt = decoded.text.search(/\r\n|\r|\n/) + (decoded.text.match(/\r\n|\r|\n/)?.[0].length ?? 0);
    const expected = decoded.text.slice(0, sourceAt) + "edited " + decoded.text.slice(sourceAt);
    expect(Buffer.from(ed.text())).toEqual(Buffer.from(expected));
    expect(undo(ed.target)).toBe(true);
    expect(Buffer.from(ed.text())).toEqual(original);
    expect(redo(ed.target)).toBe(true);
    expect(ed.text()).toBe(expected);
  });
}

test("new and pasted line breaks use the dominant original ending, with LF on ties", () => {
  for (const [source, ending] of [
    ["one\r\ntwo\r\nthree\nfour", "\r\n"],
    ["one\rtwo\rthree\nfour", "\r"],
    ["one\rtwo\r\nthree", "\n"],
    ["one\ntwo\nthree\r\nfour", "\n"],
  ]) {
    const ed = editor(source!);
    ed.edit(3, 3, "\npaste\r\nmore\rtext");
    expect(ed.text()).toBe(`one${ending}paste${ending}more${ending}text${source!.slice(3)}`);
    undo(ed.target);
    expect(ed.text()).toBe(source);
    redo(ed.target);
    expect(ed.text()).toBe(`one${ending}paste${ending}more${ending}text${source!.slice(3)}`);
  }
});

test("deleting mixed line breaks and grouped edits restore their original endings", () => {
  const source = "one\r\ntwo\rthree\nfour\r\n";
  const ed = editor(source);
  ed.edit(2, 10, "x\ny");
  ed.edit(5, 5, "\n");
  const changed = ed.text();
  undo(ed.target);
  expect(ed.text()).toBe(source);
  redo(ed.target);
  expect(ed.text()).toBe(changed);
});

test("simultaneous edits retain the endings outside each changed range", () => {
  const ed = editor("one\r\ntwo\rthree\nfour");
  ed.target.state = ed.target.state.update({ changes: [
    { from: 0, to: 4, insert: "first\n" },
    { from: 8, to: 14, insert: "third\n" },
  ] }).state;
  expect(ed.text()).toBe("first\ntwo\rthird\nfour");
  undo(ed.target);
  expect(ed.text()).toBe("one\r\ntwo\rthree\nfour");
});

test("disk reload can replace only endings or the BOM without showing them", () => {
  const ed = editor("one\ntwo");
  const next = parseByteText("\uFEFFone\r\ntwo");
  ed.target.state = ed.target.state.update({ effects: restoreByteText.of(next.format) }).state;
  expect(ed.target.state.doc.toString()).toBe("one\ntwo");
  expect(ed.text()).toBe("\uFEFFone\r\ntwo");
});

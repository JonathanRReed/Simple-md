import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { byteText, exactText, parseByteText } from "../src/renderer/byte-text";
import { editorText } from "../src/renderer/editor-text";

for (const source of ["one\ntwo\nthree", "\uFEFFone\r\ntwo\r\nthree\r\n", "one\rtwo\nthree\r\nfour\n"]) {
  test(`incremental callback text matches byte serialization for ${JSON.stringify(source)}`, () => {
    const parsed = parseByteText(source);
    let state = EditorState.create({ doc: parsed.text, extensions: [history(), byteText.init(() => parsed.format), editorText] });
    let seed = 91;
    const rand = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const check = () => expect(state.field(editorText).text).toBe(exactText(state));
    const target = { get state() { return state; }, dispatch(tr: import("@codemirror/state").Transaction) { state = tr.state; } };
    const inserts = ["x", "\n", "😀", "a\nb\nc", ""];
    for (let i = 0; i < 600; i++) {
      const from = rand(state.doc.length + 1);
      const to = Math.min(state.doc.length, from + rand(5));
      const changes = [{ from, to, insert: inserts[rand(inserts.length)]! }];
      if (i % 5 === 0 && to < state.doc.length) changes.push({ from: to + 1, to: to + 1, insert: "next\nline" });
      state = state.update({ changes }).state;
      check();
      if (i % 13 === 0) { undo(target); check(); redo(target); check(); }
    }
  });
}

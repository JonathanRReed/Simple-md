import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { byteText, exactText, parseByteText } from "../src/renderer/byte-text";
import { editorText } from "../src/renderer/editor-text";
import { sourceSelection, sourceTransaction } from "../src/renderer/source-transaction";
import { blockEdit } from "../src/renderer/block-commands";

for (const eol of ["\n", "\r\n"]) test(`100k list transaction scales with lines ${JSON.stringify(eol)}`, () => {
  const sample = (lines: number) => {
    const source = "\uFEFF" + ("A line of plain text" + eol).repeat(lines);
    const parsed = parseByteText(source);
    const state = EditorState.create({ doc: parsed.text, selection: { anchor: 0, head: parsed.text.length }, extensions: [byteText.init(() => parsed.format), editorText] });
    const edit = blockEdit(source, sourceSelection(state), "bullet-list");
    expect(edit.changes).toHaveLength(lines);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const spec = sourceTransaction(state, edit)!;
      samples.push(performance.now() - start);
      if (i === 0) expect(exactText(state.update(spec).state)).toBe("\uFEFF" + ("- A line of plain text" + eol).repeat(lines));
    }
    return samples.sort((a, b) => a - b)[2]!;
  };
  sample(500); // Warm the same conversion path before comparing sizes.
  const small = sample(5_000), large = sample(20_000);
  console.log(`sourceTransaction ${JSON.stringify(eol)} N=${small.toFixed(2)}ms 4N=${large.toFixed(2)}ms ratio=${(large / small).toFixed(2)}`);
  expect(large / small).toBeLessThan(8);
}, 120_000);

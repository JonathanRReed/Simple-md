import { expect, test } from "bun:test";
import { IncrementalBlocks } from "../src/main/incremental-blocks";
import { createWorkerRenderCore } from "../src/main/markdown";
import { applyBlockDelta } from "../src/shared/block-delta";
import type { RenderedBlock } from "../src/shared/render-core";

const fixtures = [
  '[link][ref]\n\n![image][ref]\n\n[ref]: https://before.example\n',
  'Note[^n] and more[^m].\n\n[^n]: First\n\n[^m]: Second\n',
  '# Same\n\n# Same\n\n# Same-1\n',
  '- one\n  - nested\n    > quote\n\n- two\n',
  '| A | B |\n| - | - |\n| x | y |\n',
  '```unknown\nopen fence\n\n# inside\n',
  'Setext\n======\n\ntext\n----\n',
  'import X from "./x";\n\n# MDX\n\n<Box>\n\n**child** {value}\n\n</Box>\n',
  '# Code\n\n```ts\nconst x: number = 1\n```\n',
  '\uFEFF# Astral 🚀\r\n\r\ntext\n\nlast\r',
];
const html = (blocks: RenderedBlock[]) => blocks.map(({ html, content, urls, sourceRange, itemRanges }) => ({ html, content, urls, sourceRange, itemRanges }));

test('random edit deltas equal a fresh full parse after every edit', async () => {
  let seed = 0x71612;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const insertions = ['\n', '# Same\n\n', '[ref]: https://after.example\n', '[^n]: changed\n', '| x |\n', '```\n', '---\n', '{', '}', '<Box>', '</Box>', '🚀', '**text**', ''];
  let edits = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const file = i === 7 ? '/tmp/oracle.mdx' : '/tmp/oracle.md';
    const incremental = new IncrementalBlocks();
    let text = fixtures[i]!;
    let retained: RenderedBlock[] = [];
    for (let edit = 0; edit < 40; edit++) {
      const { result, delta } = await incremental.render(text, file);
      const applied = applyBlockDelta(retained, delta);
      const oracle = await createWorkerRenderCore().renderBlocks(text, file);
      expect(html(applied.blocks)).toEqual(html(oracle.blocks));
      expect(applied.mdx).toEqual(oracle.mdx);
      expect(new Set(result.blocks.map(block => block.key)).size).toBe(result.blocks.length);
      retained = applied.blocks;
      const start = random() % (text.length + 1);
      const end = Math.min(text.length, start + random() % 9);
      text = text.slice(0, start) + insertions[random() % insertions.length] + text.slice(end);
      edits++;
    }
  }
  expect(edits).toBe(400);
}, 20_000);

test('a shifted unchanged block retains its identity and sends no HTML', async () => {
  const incremental = new IncrementalBlocks();
  const first = await incremental.render('# Title\n\nfirst\n\nlast', '/tmp/stable.md');
  const changed = await incremental.render('# Title\n\nnew\n\nfirst\n\nlast', '/tmp/stable.md');
  expect(changed.result.blocks.at(-1)!.key).toBe(first.result.blocks.at(-1)!.key);
  expect(changed.delta.changed.map(block => block.html).join('')).toContain('new');
  expect(changed.delta.changed.map(block => block.html).join('')).not.toContain('last');
});


test("retained list item source ranges shift with a delta without resending HTML", async () => {
  const incremental = new IncrementalBlocks();
  const before = await incremental.render("# Title\n\n- One\n- Two\n", "/tmp/list.md");
  const next = await incremental.render("# Title\n\nNew paragraph\n\n- One\n- Two\n", "/tmp/list.md");
  expect(next.delta.changed.map(block => block.html).join("")).not.toContain("<li>");
  expect(applyBlockDelta(before.result.blocks, next.delta).blocks.at(-1)?.itemRanges).toEqual([[4, 5], [5, 6]]);
});

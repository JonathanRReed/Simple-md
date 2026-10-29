import { expect, test } from "bun:test";
import { BlockStreams } from "../src/main/block-stream";
import { applyBlockUpdate } from "../src/shared/block-update";
import { renderBlocks } from "../src/main/markdown";

test("readable code arrives before highlighting and keyed patches equal a full render", async () => {
  const streams = new BlockStreams();
  const text = '# Plain first\n\n```ts\nconst answer: number = 42\n```';
  const first = await streams.start(text, '/tmp/readable.md');
  expect(first.blocks.map(block => block.html).join('')).not.toContain('class="shiki');
  let blocks = first.blocks;
  let patched = false;
  for (;;) {
    const update = await streams.next(first.stream!);
    if (update.kind === 'done') break;
    patched ||= update.kind === 'patch';
    blocks = applyBlockUpdate(blocks, update);
  }
  expect(patched).toBe(true);
  expect(blocks).toEqual((await renderBlocks(text, '/tmp/readable.md')).blocks);
});

test("a replaced stream cannot return old patches", async () => {
  const streams = new BlockStreams();
  const old = await streams.start('```ts\nconst old = 1\n```', '/tmp/old.md');
  const fresh = await streams.start('# Fresh', '/tmp/new.md');
  expect(await streams.next(old.stream!)).toEqual({ kind: 'done' });
  expect(await streams.next(fresh.stream!)).toEqual({ kind: 'done' });
});

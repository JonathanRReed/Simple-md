import type { RenderedBlock, RenderedBlocks } from "../shared/render-core.js";
import { blockDelta, type BlockDelta } from "../shared/block-delta.js";
import { renderBlocks } from "./markdown.js";

export class IncrementalBlocks {
  private previous: { text: string; blocks: RenderedBlock[] } | undefined;
  private sequence = 0;

  seed(text: string, result: RenderedBlocks): void { this.previous = { text, blocks: result.blocks }; }

  identify(text: string, result: RenderedBlocks): RenderedBlocks {
    const previous = this.previous;
    const before = previous?.text.split(/\r\n|[\r\n]/) ?? [];
    const after = text.split(/\r\n|[\r\n]/);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
    const shift = after.length - before.length;
    const candidates = new Map<string, RenderedBlock[]>();
    for (const block of previous?.blocks ?? []) {
      const [start, end] = block.sourceRange;
      const mapped = end <= prefix ? [start, end] : start >= before.length - suffix ? [start + shift, end + shift] : [start, end + shift];
      const range = mapped.join(":");
      const list = candidates.get(range) ?? [];
      list.push(block);
      candidates.set(range, list);
    }
    const blocks = result.blocks.map(block => {
      const old = candidates.get(block.sourceRange.join(":"))?.shift();
      const key = block.key.startsWith("mdx-error") ? block.key : old?.key ?? `b:${block.sourceRange.join(":")}:${block.key}:${++this.sequence}`;
      return { ...block, key };
    });
    this.previous = { text, blocks };
    return { ...result, blocks };
  }

  async render(text: string, filePath: string | null, mdx?: boolean): Promise<{ result: RenderedBlocks; delta: BlockDelta }> {
    const old = this.previous?.blocks ?? [];
    const result = this.identify(text, await renderBlocks(text, filePath, true, mdx));
    return { result, delta: blockDelta(old, result) };
  }
}

import type { RenderedBlocks } from "../shared/render-core.js";
import type { BlockUpdate } from "../shared/block-update.js";
import { renderBlockBatches, renderBlocks } from "./markdown.js";

export class BlockStreams {
  constructor(private readonly onRendered?: (text: string, filePath: string | null, result: RenderedBlocks) => void) {}
  private sequence = 0;
  private active: { id: number; filePath: string | null; readable: RenderedBlocks; updates: AsyncGenerator<BlockUpdate> } | undefined;

  async start(text: string, filePath: string | null): Promise<RenderedBlocks> {
    const prefix = text.length > 256 * 1024 && !/\.mdx$/i.test(filePath ?? "") ? text.slice(0, 8192) : text;
    const readable = await renderBlocks(prefix, filePath, false);
    const id = ++this.sequence;
    this.active = { id, filePath, readable, updates: this.enrich(text, filePath, readable) };
    return { ...readable, stream: id };
  }

  resume(id: number, text: string): void {
    if (this.active?.id === id) this.active.updates = this.enrich(text, this.active.filePath, this.active.readable);
  }

  async next(id: number): Promise<BlockUpdate> {
    if (this.active?.id !== id) return { kind: "done" };
    const result = await this.active.updates.next();
    if (result.done) { this.active = undefined; return { kind: "done" }; }
    return result.value;
  }

  private async *enrich(text: string, filePath: string | null, readable: RenderedBlocks): AsyncGenerator<BlockUpdate> {
    const needsHighlight = text.includes("```") || text.includes("~~~");
    if (text.length > 256 * 1024 && !/\.mdx$/i.test(filePath ?? "")) {
      let replace = true;
      const plain = [];
      for await (const batch of renderBlockBatches(text, filePath, false)) {
        if (needsHighlight) plain.push(...batch.blocks);
        yield { kind: replace ? "replace" : "append", blocks: batch.blocks };
        replace = false;
      }
      readable = { ...readable, blocks: plain };
    }
    if (!needsHighlight) {
      if (text.length <= 256 * 1024) this.onRendered?.(text, filePath, readable);
      return;
    }
    const highlighted = await renderBlocks(text, filePath);
    const changed = highlighted.blocks.flatMap((block, index) => {
      const before = readable.blocks[index];
      return before && before.fingerprint !== block.fingerprint ? [{ ...block, key: before.key }] : [];
    });
    if (changed.length) yield { kind: "patch", blocks: changed };
    if (text.length <= 256 * 1024) this.onRendered?.(text, filePath, { ...highlighted, blocks: highlighted.blocks.map((block, index) => ({ ...block, key: readable.blocks[index]?.key ?? block.key })) });
  }
}

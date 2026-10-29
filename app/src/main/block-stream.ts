import type { RenderedBlocks } from "../shared/render-core.js";
import type { BlockUpdate } from "../shared/block-update.js";
import { renderBlockBatches, renderBlocks } from "./markdown.js";

export class BlockStreams {
  private sequence = 0;
  private active: { id: number; updates: AsyncGenerator<BlockUpdate> } | undefined;

  async start(text: string, filePath: string | null): Promise<RenderedBlocks> {
    const prefix = text.length > 256 * 1024 && !/\.mdx$/i.test(filePath ?? "") ? text.slice(0, 8192) : text;
    const readable = await renderBlocks(prefix, filePath, false);
    const id = ++this.sequence;
    this.active = { id, updates: this.enrich(text, filePath, readable) };
    return { ...readable, stream: id };
  }

  async next(id: number): Promise<BlockUpdate> {
    if (this.active?.id !== id) return { kind: "done" };
    const result = await this.active.updates.next();
    if (result.done) { this.active = undefined; return { kind: "done" }; }
    return result.value;
  }

  private async *enrich(text: string, filePath: string | null, readable: RenderedBlocks): AsyncGenerator<BlockUpdate> {
    const needsHighlight = /(?:^|\n)[ \t]*(?:`{3,}|~{3,})/.test(text);
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
    if (!needsHighlight) return;
    const highlighted = await renderBlocks(text, filePath);
    const previous = new Map(readable.blocks.map(block => [block.key, block.fingerprint]));
    const changed = highlighted.blocks.filter(block => previous.get(block.key) !== block.fingerprint);
    if (changed.length) yield { kind: "patch", blocks: changed };
  }
}

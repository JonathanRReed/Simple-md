import type { RenderedBlocks } from "../shared/render-core.js";
import type { BlockUpdate } from "../shared/block-update.js";
import { renderBlocks } from "./markdown.js";

export class BlockStreams {
  private sequence = 0;
  private active: { id: number; updates: AsyncGenerator<BlockUpdate> } | undefined;

  async start(text: string, filePath: string | null): Promise<RenderedBlocks> {
    const readable = await renderBlocks(text, filePath, false);
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
    const highlighted = await renderBlocks(text, filePath);
    const previous = new Map(readable.blocks.map(block => [block.key, block.fingerprint]));
    const changed = highlighted.blocks.filter(block => previous.get(block.key) !== block.fingerprint);
    if (changed.length) yield { kind: "patch", blocks: changed };
  }
}

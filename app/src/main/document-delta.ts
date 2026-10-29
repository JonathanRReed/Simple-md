import type { RenderedBlock, RenderedBlocks } from "../shared/render-core.js";
import { blockDelta, type BlockDelta } from "../shared/block-delta.js";

let document: { id: number; blocks: RenderedBlock[] } | undefined;
export function documentDelta(id: number, result: RenderedBlocks): BlockDelta {
  const delta = blockDelta(document?.id === id ? document.blocks : [], result);
  document = { id, blocks: result.blocks };
  return delta;
}

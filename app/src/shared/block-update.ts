import type { RenderedBlock } from "./render-core.js";
import { isRenderedBlock } from "./render-tree.js";

export type BlockUpdate =
  | { kind: "replace" | "append" | "patch"; blocks: RenderedBlock[] }
  | { kind: "done" };

export function isBlockUpdate(value: unknown): value is BlockUpdate {
  return typeof value === "object" && value !== null && "kind" in value &&
    (value.kind === "done" || (["replace", "append", "patch"].includes(String(value.kind)) &&
      "blocks" in value && Array.isArray(value.blocks) && value.blocks.every(isRenderedBlock)));
}

export function applyBlockUpdate(current: RenderedBlock[], update: BlockUpdate): RenderedBlock[] {
  if (update.kind === "done") return current;
  if (update.kind === "replace") return update.blocks;
  if (update.kind === "append") return [...current, ...update.blocks];
  const changes = new Map(update.blocks.map(block => [block.key, block]));
  return current.map(block => changes.get(block.key) ?? block);
}

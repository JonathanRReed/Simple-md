import type { RenderedBlock, RenderedBlocks } from "./render-core.js";
import { isRenderedBlock } from "./render-tree.js";
import { isMdxResult } from "./mdx-result.js";

export interface BlockDelta {
  title: string;
  order: Pick<RenderedBlock, "key" | "sourceRange" | "itemRanges">[];
  changed: RenderedBlock[];
  mdx?: RenderedBlocks["mdx"];
}

export function blockDelta(previous: RenderedBlock[], result: RenderedBlocks): BlockDelta {
  const old = new Map(previous.map(block => [block.key, block]));
  return {
    title: result.title,
    order: result.blocks.map(({ key, sourceRange, itemRanges }) => ({ key, sourceRange, ...(itemRanges ? { itemRanges } : {}) })),
    changed: result.blocks.filter(block => {
      const before = old.get(block.key);
      return !before || before.fingerprint !== block.fingerprint || before.html !== block.html ||
        JSON.stringify(before.urls) !== JSON.stringify(block.urls) || JSON.stringify(before.content) !== JSON.stringify(block.content);
    }),
    ...(result.mdx ? { mdx: result.mdx } : {}),
  };
}

export function applyBlockDelta(previous: RenderedBlock[], delta: BlockDelta): RenderedBlocks {
  const retained = new Map(previous.map(block => [block.key, block]));
  for (const block of delta.changed) retained.set(block.key, block);
  const blocks = delta.order.map(({ key, sourceRange, itemRanges }) => {
    const block = retained.get(key);
    if (!block) throw new Error("Missing retained render block");
    return { ...block, sourceRange, itemRanges };
  });
  return { title: delta.title, blocks, ...(delta.mdx ? { mdx: delta.mdx } : {}) };
}

export function isBlockDelta(value: unknown): value is BlockDelta {
  if (typeof value !== "object" || value === null || !("title" in value) || typeof value.title !== "string" ||
      !("changed" in value) || !Array.isArray(value.changed) || !value.changed.every(isRenderedBlock) ||
      !("order" in value) || !Array.isArray(value.order) || ("mdx" in value && value.mdx !== undefined && !isMdxResult(value.mdx))) return false;
  const keys = new Set<string>();
  return value.order.every(item => {
    if (typeof item !== "object" || item === null || !("key" in item) || typeof item.key !== "string" || keys.has(item.key) ||
        !("sourceRange" in item) || !Array.isArray(item.sourceRange) || item.sourceRange.length !== 2 ||
        !item.sourceRange.every((line: unknown) => typeof line === "number" && Number.isSafeInteger(line) && line >= 0) || item.sourceRange[0] > item.sourceRange[1]) return false;
    if ("itemRanges" in item && item.itemRanges !== undefined && (!Array.isArray(item.itemRanges) || !item.itemRanges.every((range: unknown) => Array.isArray(range) && range.length === 2 && range.every((line: unknown) => typeof line === "number" && Number.isSafeInteger(line) && line >= 0) && range[0] <= range[1]))) return false;
    keys.add(item.key);
    return true;
  });
}

import { createHash } from "node:crypto";
import type { BlockChanges } from "../shared/change-highlights.js";
import type { RenderedBlock } from "../shared/render-core.js";
import { createWorkerRenderCore } from "./markdown.js";

type SourceBlock = Pick<RenderedBlock, "sourceRange" | "fingerprint">;

function fingerprints(text: string, blocks: SourceBlock[]): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|[\r\n]/);
  return blocks.map(block => createHash("sha256").update(lines.slice(...block.sourceRange).join("\n")).update("\0").update(block.fingerprint ?? "").digest("hex"));
}

/** Occurrence matching plus an increasing subsequence avoids a quadratic LCS table. */
export function diffSourceBlocks(before: string, old: SourceBlock[], after: string, current: SourceBlock[]): BlockChanges {
  const occurrences = new Map<string, { indices: number[]; used: number }>();
  fingerprints(before, old).forEach((key, index) => {
    let entry = occurrences.get(key);
    if (!entry) { entry = { indices: [], used: 0 }; occurrences.set(key, entry); }
    entry.indices.push(index);
  });
  const pairs: { old: number; current: number; parent: number }[] = [];
  const tails: number[] = [];
  fingerprints(after, current).forEach((key, index) => {
    const entry = occurrences.get(key);
    const previous = entry?.indices[entry.used++];
    if (previous === undefined) return;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]!]!.old < previous) lo = mid + 1;
      else hi = mid;
    }
    pairs.push({ old: previous, current: index, parent: lo ? tails[lo - 1]! : -1 });
    tails[lo] = pairs.length - 1;
  });
  const anchors: { old: number; current: number }[] = [{ old: old.length, current: current.length }];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = pairs[index]!.parent) anchors.push(pairs[index]!);
  anchors.reverse();
  const result: BlockChanges = { changed: [], deleted: [] };
  let previousOld = -1, previousCurrent = -1;
  for (const anchor of anchors) {
    const removed = anchor.old - previousOld - 1;
    const added = anchor.current - previousCurrent - 1;
    for (let i = previousCurrent + 1; i < anchor.current; i++) result.changed.push(current[i]!.sourceRange);
    if (removed > added) result.deleted.push(current[anchor.current]?.sourceRange[0] ?? current.at(-1)?.sourceRange[1] ?? 0);
    previousOld = anchor.old;
    previousCurrent = anchor.current;
  }
  return result;
}

const core = createWorkerRenderCore();
export async function calculateBlockChanges(before: string, after: string, filePath: string | null): Promise<BlockChanges> {
  if (before === after) return { changed: [], deleted: [] };
  const old = await core.renderBlocks(before, filePath, false);
  const current = await core.renderBlocks(after, filePath, false);
  return diffSourceBlocks(before, old.blocks, after, current.blocks);
}

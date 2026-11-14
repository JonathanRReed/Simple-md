import { sourceLines, type SourceSelection } from "./source-edit.js";

/** A rendered selection copies the complete source blocks it intersects. */
export function selectedSourceRanges(root: HTMLElement, text: string, selection: Selection | null): SourceSelection[] {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
  const selected = selection.getRangeAt(0);
  if (!root.contains(selected.commonAncestorContainer) && !selected.intersectsNode(root)) return [];
  const lines = sourceLines(text);
  const ranges = [...root.querySelectorAll<HTMLElement>(":scope > [data-source-start]")].filter(block => selected.intersectsNode(block)).map(block => ({
    from: lines[Number(block.dataset.sourceStart)]?.from ?? text.length,
    to: lines[Number(block.dataset.sourceEnd)]?.from ?? text.length,
  })).filter(range => range.to > range.from).sort((a, b) => a.from - b.from);
  const merged: SourceSelection[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}
export function selectedSource(root: HTMLElement, text: string, selection: Selection | null): string {
  const ranges = selectedSourceRanges(root, text, selection);
  return ranges.length ? ranges.map(range => text.slice(range.from, range.to)).join("") : text;
}

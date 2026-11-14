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

/** Count the actual selected prose, including partial blocks, from the rendered parser output. */
export function selectedReadProse(root: HTMLElement, selection: Selection | null): string | undefined {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined;
  const range = selection.getRangeAt(0).cloneRange();
  if (!range.intersectsNode(root)) return undefined;
  const bounds = document.createRange(); bounds.selectNodeContents(root);
  if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) range.setStart(root, 0);
  if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) range.setEnd(root, root.childNodes.length);
  const excluded = "pre,.frontmatter,.mdx-label,.mdx-expression,script,style";
  const parent = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (parent?.closest(excluded)) return "";
  const fragment = range.cloneContents();
  for (const node of fragment.querySelectorAll(excluded)) node.remove();
  for (const line of fragment.querySelectorAll("br")) line.replaceWith(document.createTextNode("\n"));
  for (const block of fragment.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote,tr,td,th")) block.append(document.createTextNode("\n"));
  return fragment.textContent ?? "";
}

export interface OutlineItem<T> {
  key: string;
  text: string;
  /** Zero denotes a section tick in a document without headings. */
  level: number;
  target: T;
}

export const OUTLINE_LIMIT = 120;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function sampleOutline<T>(items: readonly T[], cap = OUTLINE_LIMIT): T[] {
  const count = Math.max(1, Math.floor(cap));
  if (items.length <= count) return [...items];
  if (count === 1) return [items[0]!];
  return Array.from({ length: count }, (_, i) => items[Math.round(i * (items.length - 1) / (count - 1))]!);
}

export function deriveOutline<T>(headings: readonly OutlineItem<T>[], blocks: readonly OutlineItem<T>[], levels = 3): OutlineItem<T>[] {
  return headings.length
    ? sampleOutline(headings.filter(item => item.level <= levels))
    : sampleOutline(blocks, 24);
}

// Dock-style strip magnification adapted from T3 Code's TimelineMinimap (MIT).
export function outlineScale(index: number, active: number | null): number {
  const distance = active === null ? Infinity : Math.abs(index - active);
  return distance === 0 ? 1 : distance === 1 ? 0.667 : distance === 2 ? 0.417 : 0.333;
}

export function outlineProgress(pointerY: number, top: number, height: number): number {
  return height > 0 ? clamp((pointerY - top) / height) : 0;
}

export function outlineIndex(progress: number, count: number): number | null {
  return count > 0 ? Math.round(clamp(progress) * (count - 1)) : null;
}

export function outlineScroll(progress: number, scrollHeight: number, viewportHeight: number): number {
  return clamp(progress) * Math.max(0, scrollHeight - viewportHeight);
}

export function outlineViewport(top: number, height: number, total: number): { start: number; size: number } {
  return { start: total > 0 ? clamp(top / total) : 0, size: total > 0 ? clamp(height / total) : 1 };
}

/** Reuse sanitized rendered headings and their existing block identities, never parse Markdown. */
export function renderedOutline(root: HTMLElement, levels: number): OutlineItem<HTMLElement>[] {
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"), (element, index) => ({
    key: `${element.closest<HTMLElement>("[data-block-key]")?.dataset.blockKey ?? "heading"}:${index}`,
    text: element.textContent?.trim() || "Untitled heading", level: Number(element.tagName[1]), target: element,
  }));
  const blocks = headings.length ? [] : Array.from(root.querySelectorAll<HTMLElement>(":scope > [data-block-key]"), (element, index) => ({
    key: element.dataset.blockKey ?? String(index), text: `Section ${index + 1}`, level: 0, target: element,
  }));
  return deriveOutline(headings, blocks, levels);
}

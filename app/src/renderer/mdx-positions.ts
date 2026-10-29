import type { MdxRange, MdxSpan } from "../shared/mdx-ranges.js";
import type { MdxResult } from "../shared/render-core.js";

/** The worker sees exact disk text. CodeMirror removes the BOM and normalizes line endings. */
export function editorMdxRanges(source: string, result: MdxResult): MdxRange[] {
  const removed: number[] = source.startsWith("\uFEFF") ? [0] : [];
  for (let i = 0; i < source.length; i++) if (source[i] === "\r" && source[i + 1] === "\n") removed.push(i);
  function position(offset: number): number {
    let lo = 0, hi = removed.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (removed[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return offset - lo;
  }
  function span<T extends MdxSpan>(value: T): T {
    return { ...value, start: position(value.start), end: position(value.end) };
  }
  const ranges = result.ranges.map((range) => ({ ...span(range), syntax: range.syntax.map(span) }));
  if (result.error && result.error.end > result.error.start) ranges.push({
    ...span(result.error), kind: "mdx-comment", syntax: [{ ...span(result.error), kind: "comment" }],
  });
  return ranges;
}

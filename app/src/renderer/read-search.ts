/** Find literal text across inline nodes, without selecting or rewriting the document. */
export function readSearchRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const groups: Text[][] = [];
  let previousBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.parentElement || node.parentElement.closest("[hidden], script, style, button, svg, .katex-mathml")) continue;
    const block = node.parentElement.closest("p, li, pre, th, td, h1, h2, h3, h4, h5, h6, summary, .block") ?? root;
    if (block !== previousBlock) { groups.push([]); previousBlock = block; }
    groups.at(-1)!.push(node);
  }
  const ranges: Range[] = [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const nodes of groups) {
    const text = nodes.map(node => node.data).join("");
    for (const match of text.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      let offset = 0;
      const range = document.createRange();
      for (const node of nodes) {
        const next = offset + node.length;
        if (start >= offset && start < next) range.setStart(node, start - offset);
        if (end > offset && end <= next) { range.setEnd(node, end - offset); break; }
        offset = next;
      }
      ranges.push(range);
    }
  }
  return ranges;
}

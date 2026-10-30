export type SourceAnchor = { kind: "start" } | { kind: "end" } | {
  kind: "line";
  line: number;
  offset: number;
  block?: { key: string; fraction: number };
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const blocks = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(":scope > [data-source-start]")];

export function blockAnchor(root: HTMLElement, scroller: HTMLElement): SourceAnchor {
  if (scroller.scrollTop <= 1) return { kind: "start" };
  if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) return { kind: "end" };
  const top = scroller.getBoundingClientRect().top;
  const nodes = blocks(root);
  const node = nodes.find(block => block.getBoundingClientRect().bottom > top) ?? nodes.at(-1);
  if (!node) return { kind: "start" };
  const rect = node.getBoundingClientRect();
  const fraction = clamp((top - rect.top) / Math.max(1, rect.height));
  const start = Number(node.dataset.sourceStart), end = Number(node.dataset.sourceEnd);
  const position = start + fraction * Math.max(1, end - start);
  return { kind: "line", line: Math.floor(position), offset: position % 1, block: { key: node.dataset.blockKey ?? "", fraction } };
}

export function restoreBlockAnchor(root: HTMLElement, scroller: HTMLElement, anchor: SourceAnchor): void {
  if (anchor.kind === "start") { scroller.scrollTop = 0; return; }
  if (anchor.kind === "end") { scroller.scrollTop = scroller.scrollHeight; return; }
  const nodes = blocks(root);
  const retained = anchor.block?.key ? nodes.find(node => node.dataset.blockKey === anchor.block!.key) : undefined;
  const node = retained ?? nodes.find(node => Number(node.dataset.sourceStart) <= anchor.line && Number(node.dataset.sourceEnd) > anchor.line)
    ?? nodes.filter(node => Number(node.dataset.sourceStart) <= anchor.line).at(-1) ?? nodes[0];
  if (!node) return;
  const start = Number(node.dataset.sourceStart), end = Number(node.dataset.sourceEnd);
  const fraction = retained ? anchor.block!.fraction : clamp((anchor.line + anchor.offset - start) / Math.max(1, end - start));
  const rect = node.getBoundingClientRect();
  scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top + fraction * rect.height;
}

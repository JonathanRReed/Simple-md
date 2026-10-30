import type { RenderedBlock } from "./render-core.js";
import type { UrlContext } from "./url-resolver.js";

export interface RenderNode {
  kind: "app" | "author";
  parts: (string | RenderNode)[];
}

export interface RenderedHtml {
  /** Diagnostic serialization. Insert content through mountRenderedHtml, never this field directly. */
  html: string;
  content?: RenderNode;
  urls: UrlContext;
}

export function isRenderNode(value: unknown): value is RenderNode {
  const stack: { value: unknown; leave?: boolean }[] = [{ value }];
  const active = new Set<object>();
  const checked = new Set<object>();
  while (stack.length) {
    const item = stack.pop()!;
    const node = item.value;
    if (typeof node !== "object" || node === null) return false;
    if (item.leave) { active.delete(node); checked.add(node); continue; }
    if (active.has(node)) return false;
    if (checked.has(node)) continue;
    if (!("kind" in node) || (node.kind !== "app" && node.kind !== "author") || !("parts" in node) || !Array.isArray(node.parts)) return false;
    active.add(node);
    stack.push({ value: node, leave: true });
    for (const part of node.parts) if (typeof part !== "string") stack.push({ value: part });
  }
  return true;
}

export function isRenderedHtml(value: unknown): value is RenderedHtml {
  return typeof value === "object" && value !== null && "html" in value && typeof value.html === "string" &&
    "urls" in value && typeof value.urls === "object" && value.urls !== null &&
    (!("baseUrl" in value.urls) || typeof value.urls.baseUrl === "string") &&
    (!("rootUrl" in value.urls) || typeof value.urls.rootUrl === "string") &&
    (!("publicUrl" in value.urls) || typeof value.urls.publicUrl === "string") &&
    (!("content" in value) || isRenderNode(value.content));
}

export function isRenderedBlock(value: unknown): value is RenderedBlock {
  return isRenderedHtml(value) && "key" in value && typeof value.key === "string" &&
    "sourceRange" in value && Array.isArray(value.sourceRange) && value.sourceRange.length === 2 &&
    value.sourceRange.every((line: unknown) => typeof line === "number" && Number.isInteger(line) && line >= 0) &&
    value.sourceRange[0] <= value.sourceRange[1];
}

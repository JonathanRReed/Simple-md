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

export function isRenderNode(value: unknown, depth = 0): value is RenderNode {
  return depth < 1000 && typeof value === "object" && value !== null &&
    "kind" in value && (value.kind === "app" || value.kind === "author") &&
    "parts" in value && Array.isArray(value.parts) &&
    value.parts.every((part: unknown) => typeof part === "string" || isRenderNode(part, depth + 1));
}

export function isRenderedHtml(value: unknown): value is RenderedHtml {
  return typeof value === "object" && value !== null && "html" in value && typeof value.html === "string" &&
    "urls" in value && typeof value.urls === "object" && value.urls !== null &&
    (!("baseUrl" in value.urls) || typeof value.urls.baseUrl === "string") &&
    (!("rootUrl" in value.urls) || typeof value.urls.rootUrl === "string") &&
    (!("content" in value) || isRenderNode(value.content));
}

export function isRenderedBlock(value: unknown): value is RenderedBlock {
  return isRenderedHtml(value) && "key" in value && typeof value.key === "string" &&
    "sourceRange" in value && Array.isArray(value.sourceRange) && value.sourceRange.length === 2 &&
    value.sourceRange.every((line: unknown) => typeof line === "number" && Number.isInteger(line) && line >= 0) &&
    value.sourceRange[0] <= value.sourceRange[1];
}

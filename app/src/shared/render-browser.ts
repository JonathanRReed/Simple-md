import { createRenderCore as createCore, type RenderServices } from "./render-core.js";
import { createHighlighter, bundledLanguages, type BundledLanguage, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { authorPolicy } from "./sanitizer-policy.js";
export { authorPolicy };
import { resolveAuthorUrl, resolveSrcset } from "./url-resolver.js";
export { resolveAuthorUrl, resolveSrcset };
import { renderStaticTree } from "./sanitize-static.js";
import { staticCss, katexCss } from "./static-assets.js";
import type { UrlContext } from "./url-resolver.js";
export { sanitizeAuthorHtmlStatic } from "./sanitize-static.js";
import { staticImageUrls, embedStaticImages } from "./static-images.js";

let highlighter: Highlighter | undefined;
let loading: Promise<Highlighter> | undefined;
const themes = { light: "github-light", dark: "github-dark" } as const;
const highlighting: RenderServices = {
  async prepareHighlighting(tokens) {
    const wanted = [...new Set(tokens.filter((t) => t.type === "fence" && t.content.length <= 100_000)
      .map((t) => t.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
      .map((lang) => lang === "gitignore" ? "ini" : lang))]
      .filter((lang): lang is BundledLanguage => Object.hasOwn(bundledLanguages, lang));
    if (!wanted.length) return;
    loading ??= createHighlighter({ themes: Object.values(themes), langs: [], engine: createJavaScriptRegexEngine() });
    highlighter = await loading;
    const missing = wanted.filter((lang) => !highlighter!.getLoadedLanguages().includes(lang));
    if (missing.length) await highlighter.loadLanguage(...missing);
  },
  highlight(code, lang) {
    return highlighter?.getLoadedLanguages().includes(lang) ? highlighter.codeToHtml(code, { lang, themes, defaultColor: false }) : "";
  },
};
export function createRenderCore(services: RenderServices = {}) {
  return createCore({ ...highlighting, ...services });
}
const core = createRenderCore();
export const { renderMarkdown, renderBlocks, renderFragment } = core;

export interface StaticRenderOptions {
  /** Host-minted file URLs. Supply rootUrl for a granted project/public folder. */
  urls?: UrlContext;
  truncated?: boolean;
  invalidUtf8?: boolean;
}
const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Complete, script-free Quick Look document. Remote resources are always disabled. */
export async function renderStaticHtml(source: string, filePath: string | null, options: StaticRenderOptions = {}): Promise<string> {
  let baseUrl: string | undefined;
  if (filePath) {
    const fileUrl = filePath.startsWith("file:") ? new URL(filePath) : new URL("file://" + filePath.split("/").map(encodeURIComponent).join("/"));
    baseUrl = new URL(".", fileUrl).href;
  }
  const urls: UrlContext = { baseUrl, rootUrl: baseUrl, ...options.urls };
  const renderer = createRenderCore({ urls: () => ({ ...urls }) });
  const rendered = await renderer.renderMarkdown(source, filePath);
  const body = renderStaticTree(rendered, { urls, remoteImages: false }, true);
  // Only generated math has this class. Author classes were removed by the sanitizer.
  const mathCss = /class="katex(?: |")/.test(body) ? katexCss : "";
  const notices = (options.truncated ? '<p class="preview-notice">Showing the first 4 MB. Open in SimpleMD to read the whole file.</p>' : "") +
    (options.invalidUtf8 ? '<p class="preview-notice">Invalid UTF-8 bytes appear as replacement characters.</p>' : "");
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: file:; font-src data:";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttribute(rendered.title)}</title><style>${staticCss}\n${mathCss}\n.preview-notice,.image-unavailable{color:var(--muted);font-size:14px}.image-unavailable{display:inline-block;border:1px solid var(--rule);padding:8px 12px;border-radius:4px}</style></head><body><main class="prose">${notices}${body}</main></body></html>`;
}

Object.assign(globalThis, { SimpleMDRenderCore: { ...core, createRenderCore, renderStaticHtml, staticImageUrls, embedStaticImages, authorPolicy, resolveAuthorUrl, resolveSrcset } });

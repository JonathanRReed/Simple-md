import { createRenderCore as createCore, type RenderServices } from "./render-core.js";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { bundledLanguages, type BundledLanguage } from "shiki/langs";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { authorPolicy } from "./sanitizer-policy.js";
export { authorPolicy };
import { resolveAuthorUrl, resolveSrcset } from "./url-resolver.js";
export { resolveAuthorUrl, resolveSrcset };
import { renderStaticFragment } from "./sanitize-static.js";
import { staticCss, katexCss } from "./static-assets.js";
import type { UrlContext } from "./url-resolver.js";
export { sanitizeAuthorHtmlStatic } from "./sanitize-static.js";
import { parse, serialize, defaultTreeAdapter as tree, type DefaultTreeAdapterTypes as P } from "parse5";
import { staticImageUrls, embedStaticImages } from "./static-images.js";

let highlighter: HighlighterCore | undefined;
let loading: Promise<HighlighterCore> | undefined;
const themes = { light: "github-light", dark: "github-dark" } as const;
const highlighting: RenderServices = {
  async prepareHighlighting(tokens) {
    const wanted = [...new Set(tokens.filter((t) => t.type === "fence" && t.content.length <= 100_000)
      .map((t) => t.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
      .map((lang) => lang === "gitignore" ? "ini" : lang))]
      .filter((lang): lang is BundledLanguage => Object.hasOwn(bundledLanguages, lang));
    if (!wanted.length) return;
    loading ??= Promise.all([import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")])
      .then(([light, dark]) => createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() }));
    highlighter = await loading;
    const missing = wanted.filter((lang) => !highlighter!.getLoadedLanguages().includes(lang));
    if (missing.length) await highlighter.loadLanguage(...missing.map(lang => bundledLanguages[lang]));
  },
  highlight(code, lang) {
    // A timed-out theme pass silently extends the last colour over the rest of
    // the line. Bound fence size above, but finish both themes regardless of load.
    return highlighter?.getLoadedLanguages().includes(lang) ? highlighter.codeToHtml(code, { lang, themes, defaultColor: false, tokenizeTimeLimit: 0 }) : "";
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
export async function prepareStaticPreview(source: string, filePath: string | null, options: StaticRenderOptions = {}): Promise<P.Document> {
  let baseUrl: string | undefined;
  if (filePath) {
    const fileUrl = filePath.startsWith("file:") ? new URL(filePath) : new URL("file://" + filePath.split("/").map(encodeURIComponent).join("/"));
    baseUrl = new URL(".", fileUrl).href;
  }
  const urls: UrlContext = { baseUrl, rootUrl: baseUrl, ...options.urls };
  const renderer = createRenderCore({ urls: () => ({ ...urls }) });
  const rendered = await renderer.renderMarkdown(source, filePath);
  const body = renderStaticFragment(rendered, { urls, remoteImages: false }, true);
  // Only generated math has this class. Author classes were removed by the sanitizer.
  let hasMath = false;
  const pending = [...body.childNodes];
  while (pending.length) {
    const node = pending.pop()!;
    if (!tree.isElementNode(node)) continue;
    if (node.attrs.some(a => a.name === "class" && a.value.split(/\s+/).includes("katex"))) hasMath = true;
    for (const child of node.childNodes) pending.push(child);
  }
  const mathCss = hasMath ? katexCss : "";
  const notices = (options.truncated ? '<p class="preview-notice">Showing the first 4 MB. Open in SimpleMD to read the whole file.</p>' : "") +
    (options.invalidUtf8 ? '<p class="preview-notice">Invalid UTF-8 bytes appear as replacement characters.</p>' : "");
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  const document = parse(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttribute(rendered.title)}</title><style>${staticCss}\n${mathCss}\n.preview-notice,.image-unavailable{color:var(--muted);font-size:14px}.image-unavailable{display:inline-block;border:1px solid var(--rule);padding:8px 12px;border-radius:4px}</style></head><body><main class="prose">${notices}</main></body></html>`);
  const html = document.childNodes.find(tree.isElementNode)!;
  const documentBody = html.childNodes.find(node => tree.isElementNode(node) && node.tagName === "body")!;
  if (!tree.isElementNode(documentBody)) throw new Error("Missing preview body");
  const main = documentBody.childNodes.find(tree.isElementNode)!;
  for (const child of [...body.childNodes]) tree.appendChild(main, child);
  return document;
}

export async function renderStaticHtml(source: string, filePath: string | null, options: StaticRenderOptions = {}): Promise<string> {
  try { return serialize(await prepareStaticPreview(source, filePath, options)); }
  catch {
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><p>Preview unavailable. Showing source.</p><pre>${escapeAttribute(source)}</pre>`;
  }
}

Object.assign(globalThis, { SimpleMDRenderCore: { ...core, createRenderCore, renderStaticHtml, prepareStaticPreview, staticImageUrls, embedStaticImages, authorPolicy, resolveAuthorUrl, resolveSrcset } });

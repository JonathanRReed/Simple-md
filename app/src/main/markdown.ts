import { createHash } from "node:crypto";
import { perfMark } from "./perf.js";
import { urlContext } from "./document-urls.js";
import type { Token } from "markdown-it";
import { createRenderCore } from "../shared/render-core.js";
import type { BundledLanguage, Highlighter } from "shiki";

const resolveLang = (info: string) => {
  const raw = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_ALIASES[raw] ?? raw;
};

const THEMES = { light: "github-light", dark: "github-dark" } as const;

const MAX_HIGHLIGHT_CHARS = 100_000;
const LANGUAGE_ALIASES: Record<string, string> = { gitignore: "ini" };

let highlighterPromise: Promise<Highlighter> | undefined;
let highlighter: Highlighter | undefined;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= Promise.all([
    import("shiki"),
    import("shiki/engine/oniguruma"),
  ]).then(([{ createHighlighter }, { createOnigurumaEngine }]) => createHighlighter({
    themes: Object.values(THEMES),
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  })).then((h) => (highlighter = h)).catch((error) => {
    highlighterPromise = undefined;
    throw error;
  });
  return highlighterPromise;
}

async function prepareHighlighting(tokens: Token[]): Promise<void> {
  const wanted = new Set(tokens
    .filter((token) => token.type === "fence" && token.content.length <= MAX_HIGHLIGHT_CHARS)
    .map((token) => resolveLang(token.info))
    .filter((lang) => lang && lang !== "mermaid"));
  if (!wanted.size) return;
  const { bundledLanguages } = await import("shiki");
  const supported = [...wanted].filter((lang): lang is BundledLanguage => Object.hasOwn(bundledLanguages, lang));
  if (!supported.length) return;
  const h = await getHighlighter();
  const missing = supported.filter((lang) => !h.getLoadedLanguages().includes(lang));
  if (missing.length) await h.loadLanguage(...missing);
}

// A file watcher re-renders the same document on every save; most fences are unchanged.
// Capped by bytes, not entries: a count cap below a document's fence count thrashes
// (every insert evicts a block the same render still needs), which is worse than no cache.
const HIGHLIGHT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
let highlightCacheBytes = 0;
const highlightCache = new Map<string, string>();

function highlight(code: string, lang: string): string {
  const key = `${lang}\0${code}`;
  const hit = highlightCache.get(key);
  if (hit !== undefined) return hit;
  perfMark("highlight-start");
  const html = highlighter!.codeToHtml(code, { lang, themes: THEMES, defaultColor: false });
  perfMark("highlight-end");
  const bytes = Buffer.byteLength(key) + Buffer.byteLength(html);
  if (bytes > HIGHLIGHT_CACHE_MAX_BYTES) return html;
  highlightCache.set(key, html);
  highlightCacheBytes += bytes;
  while (highlightCacheBytes > HIGHLIGHT_CACHE_MAX_BYTES) {
    const oldest = highlightCache.keys().next();
    if (oldest.done) break;
    const evicted = highlightCache.get(oldest.value)!;
    highlightCacheBytes -= Buffer.byteLength(oldest.value) + Buffer.byteLength(evicted);
    highlightCache.delete(oldest.value);
  }
  return html;
}


const core = createRenderCore({
  prepareHighlighting,
  hash: (text) => createHash("sha256").update(text).digest("hex"),
  highlight: (code, lang) => highlighter?.getLoadedLanguages().includes(lang) ? highlight(code, lang) : "",
  urls: urlContext,
  mark: perfMark,
  byteLength: Buffer.byteLength,
});
export const { renderBlocks, renderMarkdown, renderFragment } = core;
export type { RenderedBlocks, RenderedDoc, RenderedBlock } from "../shared/render-core.js";

export { urlContext } from "./document-urls.js";

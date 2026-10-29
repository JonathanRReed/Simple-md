import { cacheBudget } from "./cache-budget.js";
import { ByteCache } from "../shared/byte-cache.js";
import { createHash } from "node:crypto";
import { perfMark } from "./perf.js";
import { urlContext } from "./document-urls.js";
import type { Token } from "markdown-it";
import { createRenderCore } from "../shared/render-core.js";
import type { HighlighterCore } from "shiki/core";

const resolveLang = (info: string) => {
  const raw = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_ALIASES[raw] ?? raw;
};

const THEMES = { light: "github-light", dark: "github-dark" } as const;

const MAX_HIGHLIGHT_CHARS = 100_000;
const LANGUAGE_ALIASES: Record<string, string> = { gitignore: "ini" };

let highlighterPromise: Promise<HighlighterCore> | undefined;
let highlighter: HighlighterCore | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/oniguruma"),
  ]).then(([{ createHighlighterCore }, { createOnigurumaEngine }]) => createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
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
  const { bundledLanguages } = await import("shiki/langs");
  const loaders = new Map(Object.entries(bundledLanguages));
  const supported = [...wanted].flatMap((lang) => {
    const load = loaders.get(lang);
    return load ? [{ lang, load }] : [];
  });
  if (!supported.length) return;
  const h = await getHighlighter();
  const missing = supported.filter(({ lang }) => !h.getLoadedLanguages().includes(lang));
  if (missing.length) await h.loadLanguage(...missing.map(({ load }) => load()));
}

// A file watcher re-renders the same document on every save; most fences are unchanged.
// Capped by bytes, not entries: a count cap below a document's fence count thrashes
// (every insert evicts a block the same render still needs), which is worse than no cache.
const highlightCache = new ByteCache<string>(cacheBudget);

function highlight(code: string, lang: string): string {
  const key = `${lang}\0${code}`;
  const hit = highlightCache.get(key);
  if (hit !== undefined) return hit;
  perfMark("highlight-start");
  const html = highlighter!.codeToHtml(code, { lang, themes: THEMES, defaultColor: false });
  perfMark("highlight-end");
  const bytes = Buffer.byteLength(key) + Buffer.byteLength(html);
  highlightCache.set(key, html, 2 * bytes);
  return html;
}


export const createWorkerRenderCore = () => createRenderCore({
  cacheBudget,
  prepareHighlighting,
  hash: (text) => createHash("sha256").update(text).digest("hex"),
  highlight: (code, lang) => highlighter?.getLoadedLanguages().includes(lang) ? highlight(code, lang) : "",
  urls: urlContext,
  mark: perfMark,
  byteLength: Buffer.byteLength,
});
const core = createWorkerRenderCore();
export const { renderBlocks, renderBlockBatches, renderMarkdown, renderFragment } = core;
export type { RenderedBlocks, RenderedDoc, RenderedBlock } from "../shared/render-core.js";

export { urlContext } from "./document-urls.js";

import { perfMark } from "./perf.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Token } from "markdown-it";
import { createMarkdownParser } from "../shared/markdown-parser.js";
import type { BundledLanguage, Highlighter } from "shiki";

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

const resolveLang = (info: string) => {
  const raw = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_ALIASES[raw] ?? raw;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// GitHub's slug rules, so links copied from READMEs keep working.
const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");

// Heading ids are prefixed so a heading named "doc" cannot take over the app's own element ids.
const FRAGMENT_PREFIX = "user-content-";

const md = createMarkdownParser((code, rawLang) => {
  const lang = resolveLang(rawLang);
  if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(code)}</pre>`;
  if (!lang || !highlighter || code.length > MAX_HIGHLIGHT_CHARS) return "";
  if (!highlighter.getLoadedLanguages().includes(lang)) return "";
  return highlight(code, lang);
});

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const html = defaultFence(tokens, idx, options, env, self);
  const lang = resolveLang(tokens[idx]!.info);
  if (lang === "mermaid") return html;
  const label = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
  return `<div class="code-block"${label}><button class="copy-code" type="button" aria-label="Copy code">Copy</button>${html}</div>`;
};

md.renderer.rules.code_inline = (tokens, idx) =>
  `<code dir="ltr">${escapeHtml(tokens[idx]!.content)}</code>`;

const DIR_BLOCKS = new Set([
  "paragraph_open",
  "heading_open",
  "bullet_list_open",
  "ordered_list_open",
  "blockquote_open",
  "table_open",
]);

// Each top-level block takes the direction of its own first strong character, so
// Arabic or Hebrew paragraphs read right to left beside English ones.
md.core.ruler.push("block_direction", (state) => {
  for (const tok of state.tokens) {
    if (tok.level === 0 && DIR_BLOCKS.has(tok.type)) tok.attrSet("dir", "auto");
  }
});

function inlineText(tokens: Token[]): string {
  return tokens.map((token) => token.children ? inlineText(token.children) :
    token.type === "softbreak" || token.type === "hardbreak" ? " " : token.content).join("");
}

md.core.ruler.push("heading_ids", (state) => {
  const suffix = new Map<string, number>();
  const used = new Set<string>();
  state.tokens.forEach((tok, i) => {
    if (tok.type !== "heading_open") return;
    const inline = state.tokens[i + 1];
    const slug = slugify(inline?.children ? inlineText(inline.children) : inline?.content ?? "");
    if (!slug) return;
    let n = suffix.get(slug) ?? 0;
    let candidate = n ? `${slug}-${n}` : slug;
    while (used.has(candidate)) candidate = `${slug}-${++n}`;
    suffix.set(slug, n + 1);
    used.add(candidate);
    tok.attrSet("id", FRAGMENT_PREFIX + candidate);
  });
});

md.core.ruler.push("local_images", (state) => {
  const baseDir = (state.env as RenderEnv).baseDir;
  if (!baseDir) return;
  const visit = (tokens: typeof state.tokens) => {
    for (const tok of tokens) {
      if (tok.type === "image") {
        const src = String(tok.attrGet("src") ?? "");
        if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//")) {
          const base = pathToFileURL(path.resolve(baseDir) + path.sep);
          tok.attrSet("src", new URL(src, base).href);
        }
      }
      if (tok.children) visit(tok.children);
    }
  };
  visit(state.tokens);
});

type RenderEnv = { baseDir?: string } & Record<PropertyKey, unknown>;

const FENCE = /^\s*(```|~~~)/;

// MDX is view-only: drop ESM statements and show JSX blocks as code instead of executing them.
export function preprocessMdx(src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (/^(import|export)\s/.test(line)) {
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") i++;
      continue;
    }
    if (/^\s*\{\/\*.*\*\/\}\s*$/.test(line)) continue;
    if (/^\s*<[A-Z][\w.]*[\s/>]/.test(line)) {
      const block = [line];
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") block.push(lines[++i]!);
      out.push("```jsx", ...block, "```");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function splitFrontmatter(src: string): { body: string; title?: string; raw?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { body: src };
  const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(m[1]!)?.[1];
  return { body: src.slice(m[0].length), title, raw: m[1] };
}

export interface RenderedDoc {
  html: string;
  title: string;
}

export interface RenderedBlock {
  /** Stable content hash: unchanged blocks keep their key across edits, moves and re-renders. */
  key: string;
  html: string;
}

export interface RenderedBlocks {
  title: string;
  blocks: RenderedBlock[];
}

// Cache resolved tokens, since document context changes heading ids, references and footnotes.
const BLOCK_CACHE_MAX_BYTES = 24 * 1024 * 1024;
let blockCacheBytes = 0;
const blockCache = new Map<string, string>();

function hash(s: string): string {
  // Two interleaved 32-bit FNV lanes via Math.imul: all-int32, no BigInt, ~100x faster
  // per character. Plenty of collision resistance for cache keys on one machine.
  let a = 0x811c9dc5;
  let b = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
    b = (b << 13) | (b >>> 19);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}


function tokenState(tokens: Token[]): unknown[] {
  return tokens.map((token) => [
    token.type, token.tag, token.attrs, token.nesting, token.content,
    token.info, token.markup, token.hidden, token.meta,
    token.children ? tokenState(token.children) : null,
  ]);
}

export async function renderBlocks(src: string, filePath: string | null): Promise<RenderedBlocks> {
  const { body, title, raw } = splitFrontmatter(src.replace(/^\uFEFF/, ""));
  const isMdx = filePath !== null && path.extname(filePath).toLowerCase() === ".mdx";
  const text = isMdx ? preprocessMdx(body) : body;
  const env: RenderEnv = { baseDir: filePath ? path.dirname(filePath) : undefined };
  perfMark("parse-start");
  const tokens = md.parse(text, env);
  perfMark("parse-end");
  perfMark("highlight-prepare-start");
  await prepareHighlighting(tokens);
  perfMark("highlight-prepare-end");

  // Balance nesting rather than source maps so generated footnote sections stay intact.
  const groups: Token[][] = [];
  let depth = 0;
  for (const token of tokens) {
    if (depth === 0) groups.push([]);
    groups[groups.length - 1]!.push(token);
    depth += token.nesting;
  }

  perfMark("html-serialize-start");
  const blocks: RenderedBlock[] = [];
  const seenKeys = new Map<string, number>();
  if (raw !== undefined) {
    const html = `<details class="frontmatter" dir="ltr"><summary>Properties</summary><pre>${escapeHtml(raw)}</pre></details>`;
    blocks.push({ key: "fm" + hash(raw), html });
  }
  for (const group of groups) {
    const key = hash(JSON.stringify(tokenState(group)));
    let html = blockCache.get(key);
    if (html === undefined) {
      html = md.renderer.render(group, md.options, env);
      const bytes = Buffer.byteLength(key) + Buffer.byteLength(html);
      if (bytes <= BLOCK_CACHE_MAX_BYTES) {
        blockCache.set(key, html);
        blockCacheBytes += bytes;
        while (blockCacheBytes > BLOCK_CACHE_MAX_BYTES) {
          const oldest = blockCache.keys().next();
          if (oldest.done) break;
          blockCacheBytes -= Buffer.byteLength(oldest.value) + Buffer.byteLength(blockCache.get(oldest.value)!);
          blockCache.delete(oldest.value);
        }
      }
    }
    const seen = seenKeys.get(key) ?? 0;
    seenKeys.set(key, seen + 1);
    blocks.push({ key: seen ? `${key}~${seen}` : key, html });
  }
  perfMark("html-serialize-end");
  return { title: title ?? (filePath ? path.basename(filePath, path.extname(filePath)) : "Untitled"), blocks };
}

async function renderBody(text: string, baseDir: string | undefined): Promise<string> {
  const env: RenderEnv = { baseDir };
  perfMark("parse-start");
  const tokens = md.parse(text, env);
  perfMark("parse-end");
  perfMark("highlight-prepare-start");
  await prepareHighlighting(tokens);
  perfMark("highlight-prepare-end");

  return md.renderer.render(tokens, md.options, env);
}

// `filePath` is null for a document that has not been saved yet.
export async function renderMarkdown(src: string, filePath: string | null): Promise<RenderedDoc> {
  const { body, title, raw } = splitFrontmatter(src.replace(/^\uFEFF/, ""));
  const isMdx = filePath !== null && path.extname(filePath).toLowerCase() === ".mdx";
  const html = await renderBody(isMdx ? preprocessMdx(body) : body, filePath ? path.dirname(filePath) : undefined);
  const properties = raw
    ? `<details class="frontmatter" dir="ltr"><summary>Properties</summary><pre>${escapeHtml(raw)}</pre></details>`
    : "";
  return {
    html: properties + html,
    title: title ?? (filePath ? path.basename(filePath, path.extname(filePath)) : "Untitled"),
  };
}

// A single block (table, fence, math) rendered with the same pipeline, for the live editor.
export function renderFragment(src: string, baseDir: string | undefined): Promise<string> {
  return renderBody(src, baseDir);
}

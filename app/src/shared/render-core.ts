import { findMdxRanges, type MdxRange, type MdxParseError } from "./mdx-ranges.js";
import { mapMdxPreview, type MdxPreview } from "./mdx-preview.js";
import type { Token } from "markdown-it";
import { createMarkdownParser } from "./markdown-parser.js";
import { resolveAuthorUrl, type UrlContext } from "./url-resolver.js";
import { type RenderedHtml, type RenderNode } from "./render-tree.js";
import GithubSlugger from "github-slugger";
import { renderFrontmatter } from "./frontmatter.js";
export type { RenderedHtml } from "./render-tree.js";

export interface RenderServices {
  prepareHighlighting?(tokens: Token[]): Promise<void>;
  highlight?(code: string, language: string): string;
  urls?(baseDir: string | undefined, discoverRoot: boolean): UrlContext;
  hash?(text: string): string;
  byteLength?(text: string): number;
  mark?(name: string): void;
}
const MAX_HIGHLIGHT_CHARS = 100_000;
const LANGUAGE_ALIASES: Record<string, string> = { gitignore: "ini" };
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
function splitFrontmatter(src: string): { body: string; title?: string; raw?: string } {
  const m = /^---(?:\r\n|[\r\n])([\s\S]*?)(?:\r\n|[\r\n])---(?:(?:\r\n|[\r\n])|$)/.exec(src);
  if (!m) return { body: src };
  const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(m[1]!)?.[1];
  return { body: src.slice(m[0].length), title, raw: m[1] };
}

// This scanner only decides cache/block boundaries. It grants no HTML privileges;
// the DOM parser and DOMPurify still parse and sanitize the entire author unit.
function groupRawWrappers(groups: Token[][]): Token[][] {
  const result: Token[][] = [];
  let pending: Token[] = [];
  const stack: string[] = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const rawTextTags = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
  for (const group of groups) {
    pending.push(...group);
    for (const token of group) {
      if (token.type !== "html_block") continue;
      const tags = /<!--[\s\S]*?(?:-->|$)|<![^>]*(?:>|$)|<\/?([a-z][a-z0-9:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*(?:>|$)/gi;
      for (const match of token.content.matchAll(tags)) {
        const name = match[1]?.toLowerCase();
        if (!name) continue;
        const closing = match[0].startsWith("</");
        const top = stack.at(-1);
        if (top && rawTextTags.has(top) && !(closing && name === top)) continue;
        if (closing) {
          const index = stack.lastIndexOf(name);
          if (index >= 0) stack.splice(index);
        } else if (!voidTags.has(name)) stack.push(name);
      }
    }
    if (!stack.length) { result.push(pending); pending = []; }
  }
  if (pending.length) result.push(pending);
  return result;
}

export interface RenderedDoc extends RenderedHtml { title: string }
export interface RenderedBlock extends RenderedHtml {
  key: string;
  fingerprint?: string;
  /** Zero-based, end-exclusive source lines, including frontmatter offset. */
  sourceRange: [number, number];
}
export interface MdxResult { ranges: MdxRange[]; error?: MdxParseError }
export interface RenderedBlocks { title: string; blocks: RenderedBlock[]; mdx?: MdxResult; stream?: number }
const resolveLang = (info: string) => {
  const raw = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_ALIASES[raw] ?? raw;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Heading ids are prefixed so a heading named "doc" cannot take over the app's own element ids.
const FRAGMENT_PREFIX = "user-content-";

export function createRenderCore(services: RenderServices = {}) {
  let highlighting = true;
  const md = createMarkdownParser((code, rawLang) => {
    const lang = resolveLang(rawLang);
    if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(code)}</pre>`;
    if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return "";
    return highlighting ? services.highlight?.(code, lang) ?? "" : "";
  });

  const previewNodes = new WeakMap<Token, RenderNode>();
  md.inline.ruler.before("text", "mdx_preview", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 64) return false;
    const nodes = (state.env as RenderEnv).mdxNodes;
    if (!nodes) return false;
    const end = state.src.indexOf("END@", state.pos);
    if (end < 0) return false;
    const marker = state.src.slice(state.pos, end + 4);
    const node = nodes.get(marker);
    if (!node) return false;
    if (!silent) {
      const token = state.push("mdx_preview", "", 0);
      token.meta = { mdx: node };
      previewNodes.set(token, node);
    }
    state.pos += marker.length;
    return true;
  });
  md.block.ruler.before("paragraph", "mdx_preview", (state, line, _end, silent) => {
    const marker = state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!).trim();
    const node = (state.env as RenderEnv).mdxNodes?.get(marker);
    if (!node) return false;
    if (!silent) {
      const token = state.push("mdx_preview", "", 0);
      token.meta = { mdx: node };
      previewNodes.set(token, node);
      token.map = [line, line + 1];
    }
    state.line = line + 1;
    return true;
  });
  const serialize = (node: RenderNode): string => {
    const output: string[] = [];
    const stack: (string | RenderNode)[] = [node];
    while (stack.length) {
      const part = stack.pop()!;
      if (typeof part === "string") output.push(part);
      else for (let i = part.parts.length - 1; i >= 0; i--) stack.push(part.parts[i]!);
    }
    return output.join("");
  };
  md.renderer.rules.mdx_preview = (tokens, idx) => {
    // Created by mapMdxPreview in this process. Validate once at the worker boundary.
    const node = previewNodes.get(tokens[idx]!);
    return node ? serialize(node) : "";
  };

  const defaultFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = defaultFence(tokens, idx, options, env, self);
    const lang = resolveLang(tokens[idx]!.info);
    if (lang === "mermaid" || lang === "math") return html;
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
    return tokens.map((token) => token.type === "image" || token.type === "html_inline" ? "" : token.children ? inlineText(token.children) :
      token.type === "softbreak" || token.type === "hardbreak" ? "\n" : token.content).join("");
  }

  md.core.ruler.push("heading_ids", (state) => {
    const slugger = new GithubSlugger();
    state.tokens.forEach((tok, i) => {
      if (tok.type !== "heading_open") return;
      const inline = state.tokens[i + 1];
      const slug = slugger.slug(inline?.children ? inlineText(inline.children) : inline?.content ?? "");
      tok.attrSet("id", FRAGMENT_PREFIX + slug);
    });
  });

  md.core.ruler.push("urls", (state) => {
    const env = state.env as RenderEnv;
    const context = env.urls;
    let rootReady = false;
    const rootContext = () => {
      if (!rootReady) Object.assign(context, services.urls?.(env.baseDir, true));
      rootReady = true;
    };
    const visit = (tokens: Token[]) => {
      for (const tok of tokens) {
        if (tok.type === "html_block" || tok.type === "html_inline" || tok.type === "mdx_preview") rootContext();
        const attr = tok.type === "image" ? "src" : tok.type === "link_open" ? "href" : null;
        if (attr) {
          const original = String(tok.attrGet(attr) ?? "");
          if (/^\/(?!\/)/.test(original)) rootContext();
          const resolved = resolveAuthorUrl(original, attr === "src" ? "resource" : "anchor", context);
          if (resolved !== null) tok.attrSet(attr, resolved);
          else tok.attrs = tok.attrs?.filter(([name]) => name !== attr) ?? null;
        }
        if (tok.children) visit(tok.children);
      }
    };
    visit(state.tokens);
  });

  type RenderEnv = { urls: UrlContext; baseDir?: string; mdxNodes?: Map<string, RenderNode> } & Record<PropertyKey, unknown>;

  const hash = services.hash ?? defaultHash;
  const byteLength = services.byteLength ?? utf8ByteLength;
  // Cache resolved tokens, since document context changes heading ids, references and footnotes.
  const BLOCK_CACHE_MAX_BYTES = 24 * 1024 * 1024;
  let blockCacheBytes = 0;
  const blockCache = new Map<string, RenderedHtml>();

  function defaultHash(s: string): string {
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

  // Unchanged sources are rendered repeatedly (mode switches, cache checks), so reuse recent parses.
  const mdxCache = new Map<string, ReturnType<typeof findMdxRanges>>();
  function cachedMdxRanges(src: string): ReturnType<typeof findMdxRanges> {
    const hit = mdxCache.get(src);
    if (hit) {
      mdxCache.delete(src);
      mdxCache.set(src, hit);
      return hit;
    }
    const ranges = findMdxRanges(src);
    mdxCache.set(src, ranges);
    if (mdxCache.size > 4) mdxCache.delete(mdxCache.keys().next().value!);
    return ranges;
  }

  async function renderBlocks(src: string, filePath: string | null, highlighted = true): Promise<RenderedBlocks> {
    highlighting = highlighted;
    const { body, title, raw } = splitFrontmatter(src.replace(/^\uFEFF/, ""));
    const isMdx = filePath !== null && /\.mdx$/i.test(filePath);
    services.mark?.("mdx-parse-start");
    const ranges = isMdx ? cachedMdxRanges(src) : undefined;
    services.mark?.("mdx-parse-end");
    const mdx: MdxResult | undefined = ranges ? { ranges: [...ranges], error: ranges.error } : undefined;
    const baseDir = filePath ? filePath.replace(/[/\\][^/\\]*$/, "") : undefined;
    const env: RenderEnv = { baseDir, urls: services.urls?.(baseDir, false) ?? {} };
    let text = body;
    let sourceLine = (line: number) => line;
    if (ranges) {
      const bodyOffset = src.length - body.length;
      const usable = ranges.filter((range) => !ranges.error || range.end <= ranges.error.start).map((range) => ({
        ...range, start: range.start - bodyOffset, end: range.end - bodyOffset,
        syntax: range.syntax.map((span) => ({ ...span, start: span.start - bodyOffset, end: span.end - bodyOffset })),
      }));
      const validBody = ranges.error ? body.slice(0, Math.max(0, ranges.error.start - bodyOffset)) : body;
      const renderChild = async (preview: MdxPreview, inline: boolean): Promise<RenderNode> => {
        const childEnv = { ...env, mdxNodes: preview.nodes };
        const childTokens = inline ? md.parseInline(preview.text.trim(), childEnv) : md.parse(preview.text, childEnv);
        if (highlighted) await services.prepareHighlighting?.(childTokens);
        return planSequence(childTokens, childEnv, false);
      };
      const preview = await mapMdxPreview(validBody, usable, renderChild);
      text = preview.text;
      env.mdxNodes = preview.nodes;
      sourceLine = (line) => preview.lineMap[line] ?? preview.endLine;
    }
    services.mark?.("parse-start");
    const tokens = md.parse(text, env);
    services.mark?.("parse-end");
    services.mark?.("highlight-prepare-start");
    if (highlighted) await services.prepareHighlighting?.(tokens);
    services.mark?.("highlight-prepare-end");

    // Balance nesting rather than source maps so generated footnote sections stay intact.
    const groups: Token[][] = [];
    let depth = 0;
    for (const token of tokens) {
      if (depth === 0) groups.push([]);
      groups[groups.length - 1]!.push(token);
      depth += token.nesting;
    }

    const balancedGroups = groupRawWrappers(groups);
    const lineCount = 1 + (body.match(/\r\n|[\r\n]/g)?.length ?? 0);
    const offset = src.replace(/^\uFEFF/, "").slice(0, src.replace(/^\uFEFF/, "").length - body.length).match(/\r\n|[\r\n]/g)?.length ?? 0;
    highlighting = highlighted;
    services.mark?.("html-serialize-start");
    const blocks: RenderedBlock[] = [];
    const seenKeys = new Map<string, number>();
    if (raw !== undefined) {
      const html = renderFrontmatter(raw);
      blocks.push({ key: "fm" + hash(raw), html, urls: env.urls, sourceRange: [0, offset] });
    }
    for (const group of balancedGroups) {
      const key = hash(JSON.stringify(tokenState(group)) + (hasAuthor(group) ? JSON.stringify(env.urls) : ""));
      const cacheKey = `${highlighted ? "highlight" : "plain"}:${key}`;
      let rendered = blockCache.get(cacheKey);
      if (rendered === undefined) {
        const html = md.renderer.render(group, md.options, env);
        rendered = { html, urls: env.urls };
        if (hasAuthor(group)) rendered.content = planSequence(group, env, false);
        const bytes = byteLength(key) + byteLength(rendered.html) + (rendered.content ? byteLength(JSON.stringify(rendered.content)) : 0);
        if (bytes <= BLOCK_CACHE_MAX_BYTES) {
          blockCache.set(cacheKey, rendered);
          blockCacheBytes += bytes;
          while (blockCacheBytes > BLOCK_CACHE_MAX_BYTES) {
            const oldest = blockCache.keys().next();
            if (oldest.done) break;
            blockCacheBytes -= byteLength(oldest.value) + byteLength(blockCache.get(oldest.value)!.html) + (blockCache.get(oldest.value)!.content ? byteLength(JSON.stringify(blockCache.get(oldest.value)!.content)) : 0);
            blockCache.delete(oldest.value);
          }
        }
      }
      const seen = seenKeys.get(key) ?? 0;
      seenKeys.set(key, seen + 1);
      const maps = group.flatMap((token) => token.map ? [token.map] : []);
      const sourceRange: [number, number] = maps.length ? [offset + sourceLine(Math.min(...maps.map((m) => m[0]))), offset + sourceLine(Math.max(...maps.map((m) => m[1])))] : [offset + lineCount - 1, offset + lineCount - 1];
      blocks.push({ key: seen ? `${key}~${seen}` : key, fingerprint: hash(rendered.html + (rendered.content ? JSON.stringify(rendered.content) : "")), ...rendered, urls: env.urls, sourceRange });
    }
    if (mdx?.error) {
      const html = `<div class="mdx-error"><span class="mdx-label">Incomplete MDX</span><pre>${escapeHtml(src.slice(mdx.error.start, mdx.error.end))}</pre></div>`;
      blocks.push({ key: "mdx-error" + hash(html), html, urls: env.urls, sourceRange: [mdx.error.startLine - 1, mdx.error.endLine] });
    }
    services.mark?.("html-serialize-end");
    return { ...(mdx ? { mdx } : {}), title: title ?? (filePath ? filePath.split(/[/\\]/).pop()!.replace(/\.[^.]*$/, "") : "Untitled"), blocks };
  }

  async function renderBody(text: string, baseDir: string | undefined): Promise<RenderedHtml> {
    highlighting = true;
    const env: RenderEnv = { baseDir, urls: services.urls?.(baseDir, false) ?? {} };
    const tokens = md.parse(text, env);
    await services.prepareHighlighting?.(tokens);
    return { html: md.renderer.render(tokens, md.options, env), urls: env.urls,
      ...(hasAuthor(tokens) ? { content: planSequence(tokens, env, false) } : {}) };
  }

  async function renderMarkdown(src: string, filePath: string | null): Promise<RenderedDoc> {
    const { title, blocks } = await renderBlocks(src, filePath);
    return { title, html: blocks.map((b) => b.html).join(""), urls: blocks[0]?.urls ?? {},
      ...(blocks.some((b) => b.content) ? { content: { kind: "app", parts: blocks.map((b) => b.content ?? { kind: "app", parts: [b.html] }) } satisfies RenderNode } : {}) };
  }

  function renderFragment(src: string, baseDir: string | undefined): Promise<RenderedHtml> {
    return renderBody(src, baseDir);
  }

  function hasAuthor(tokens: Token[]): boolean {
    return tokens.some((t) => t.type === "html_block" || t.type === "html_inline" || t.type === "mdx_preview" || (t.children && hasAuthor(t.children)));
  }

  // Each app node contains only parser/plugin output. Author strings and app nodes
  // meet only inside an author node, through unpredictable DOM-time placeholder tags.
  function planSequence(tokens: Token[], env: RenderEnv, inline: boolean): RenderNode {
    if (!hasAuthor(tokens)) return { kind: "app", parts: [inline ? md.renderer.renderInline(tokens, md.options, env) : md.renderer.render(tokens, md.options, env)] };
    const parts: (string | RenderNode)[] = [];
    let author = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.type === "mdx_preview") {
        const node = previewNodes.get(token);
        if (node) parts.push(node);
      } else if (token.type === "html_block" || token.type === "html_inline") {
        author = true;
        parts.push(token.content);
      } else if (token.type === "inline") {
        parts.push(planSequence(token.children ?? [], env, true));
      } else if (token.nesting === 1) {
        let end = i + 1;
        let depth = 1;
        while (end < tokens.length) {
          depth += tokens[end]!.nesting;
          if (!depth) break;
          end++;
        }
        const renderToken = (idx: number) => {
          const t = tokens[idx]!;
          const rule = md.renderer.rules[t.type];
          return rule ? rule(tokens, idx, md.options, env, md.renderer) : md.renderer.renderToken(tokens, idx, md.options);
        };
        parts.push({ kind: "app", parts: [renderToken(i), planSequence(tokens.slice(i + 1, end), env, inline), end < tokens.length ? renderToken(end) : ""] });
        i = end;
      } else {
        const rule = md.renderer.rules[token.type];
        parts.push({ kind: "app", parts: [rule ? rule(tokens, i, md.options, env, md.renderer) : md.renderer.renderToken(tokens, i, md.options)] });
      }
    }
    return { kind: author ? "author" : "app", parts };
  }
  return { renderBlocks, renderMarkdown, renderFragment };

}

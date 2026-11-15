import { ByteCache, CacheBudget } from "./byte-cache.js";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { parser, GFM } from "@lezer/markdown";
import { sourceLines, type SourceSelection } from "../renderer/source-edit.js";

export type { ProseCount, ProseCounts } from "./prose-count-result.js";
import type { ProseCount, ProseCounts } from "./prose-count-result.js";
const markdown = parser.configure(GFM);
// The MDX parser is several megabytes of code. Plain Markdown never loads it.
let mdxTools: { findMdxRanges: typeof import("./mdx-ranges.js").findMdxRanges; jsxContentBounds: typeof import("./mdx-preview.js").jsxContentBounds } | undefined;
/** Call before counting an MDX document. */
export async function loadProseMdx(): Promise<void> {
  if (mdxTools) return;
  const [{ findMdxRanges }, { jsxContentBounds }] = await Promise.all([import("./mdx-ranges.js"), import("./mdx-preview.js")]);
  mdxTools = { findMdxRanges, jsxContentBounds };
}
const excluded = new Set(["FencedCode", "CodeBlock", "HTMLTag", "LinkMark", "URL", "LinkTitle", "LinkLabel", "EmphasisMark", "CodeMark", "HeaderMark", "QuoteMark", "ListMark", "TaskMarker", "TableDelimiter", "TableMark", "HorizontalRule", "LinkReference", "Escape"]);
const wordPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Parser ranges remove non-prose; counting runs only in the counter worker. */
export function prepareProseCount(source: string, mdx = false) {
  const lines = sourceLines(source);
  const ranges: { from: number; to: number; insert?: string }[] = [];
  if (source.startsWith("\uFEFF")) ranges.push({ from: 0, to: 1 });
  if (lines[0]?.text === "---") {
    const end = lines.findIndex((line, index) => index > 0 && (line.text === "---" || line.text === "..."));
    if (end > 0) ranges.push({ from: lines[0].from, to: lines[end]!.end });
  }
  if (mdx && !mdxTools) throw new Error("Call loadProseMdx() before counting an MDX document.");
  const mdxRanges = mdx ? mdxTools!.findMdxRanges(source) : undefined;
  if (mdxRanges?.error) ranges.push({ from: mdxRanges.error.start, to: mdxRanges.error.end });
  if (mdxRanges) for (const range of mdxRanges) {
    if ((range.kind === "jsx-flow" || range.kind === "jsx-text") && range.name !== "script" && range.name !== "style") {
      const { end, innerEnd } = mdxTools!.jsxContentBounds(source, range);
      ranges.push({ from: range.start, to: end }, { from: innerEnd, to: range.end });
    } else ranges.push({ from: range.start, to: range.end });
  }
  // Mask imports/JSX before Markdown parsing so JSX children remain Markdown prose.
  // Code units in a typed array: an array of one-character strings costs many times the document's size.
  let masked = source;
  if (ranges.length) {
    const units = new Uint16Array(source.length);
    for (let i = 0; i < source.length; i++) units[i] = source.charCodeAt(i);
    const newline = (unit: number | undefined) => unit === 10 || unit === 13;
    for (const range of ranges) for (let i = range.from; i < range.to; i++) {
      if (newline(units[i])) continue;
      // Each masked line keeps one letter so it still reads as a paragraph line; a leading byte-order mark does not.
      units[i] = i === 0 && source.charCodeAt(0) === 0xFEFF ? 32 : i === range.from || newline(source.charCodeAt(i - 1)) ? 120 : 32;
    }
    masked = new TextDecoder("utf-16le").decode(units);
  }
  markdown.parse(masked).iterate({ enter(node) {
    if (node.name === "HTMLBlock") {
      const fragment = parseFragment(masked.slice(node.from, node.to), { sourceCodeLocationInfo: true });
      const tags = new Set(["p", "div", "section", "li", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);
      const visit = (child: DefaultTreeAdapterMap["node"]) => {
        const location = child.sourceCodeLocation;
        if ("tagName" in child && location) {
          if (child.tagName === "script" || child.tagName === "style") { ranges.push({ from: node.from + location.startOffset, to: node.from + location.endOffset, insert: " " }); return; }
          for (const tag of ["startTag" in location ? location.startTag : undefined, "endTag" in location ? location.endTag : undefined]) if (tag) ranges.push({ from: node.from + tag.startOffset, to: node.from + tag.endOffset, insert: tags.has(child.tagName) ? " " : "" });
        } else if (child.nodeName === "#comment" && location) ranges.push({ from: node.from + location.startOffset, to: node.from + location.endOffset });
        if ("childNodes" in child) child.childNodes.forEach(visit);
      };
      fragment.childNodes.forEach(visit);
      return false;
    }
    if (node.name === "Entity") {
      const entity = parseFragment(masked.slice(node.from, node.to)).childNodes[0];
      ranges.push({ from: node.from, to: node.to, insert: entity && "value" in entity ? entity.value : "" });
      return false;
    }
    if (excluded.has(node.name)) {
      // Escapes have one syntax byte; their escaped character is prose.
      ranges.push({ from: node.from, to: node.name === "Escape" ? node.from + 1 : node.to, insert: node.name === "FencedCode" || node.name === "CodeBlock" ? " " : "" });
      return false;
    }
  } });
  ranges.sort((a, b) => a.from - b.from);
  function count(from: number, to: number): ProseCount {
    const parts: string[] = [];
    let cursor = from;
    for (const range of ranges) {
      if (range.to <= cursor) continue;
      if (range.from >= to) break;
      if (range.from > cursor) parts.push(source.slice(cursor, Math.min(range.from, to)));
      if (range.insert && range.from >= from) parts.push(range.insert);
      cursor = Math.max(cursor, range.to);
    }
    if (cursor < to) parts.push(source.slice(cursor, to));
    return countProseText(parts.join(""));
  }
  const document = count(0, source.length);
  const countSelection = (selection?: SourceSelection, selectedText?: string): ProseCounts => ({ document, ...(selectedText ? { selection: countProseText(selectedText) } : selection && selection.from !== selection.to ? { selection: count(selection.from, selection.to) } : {}), minutes: Math.max(1, Math.ceil(document.words / 230)) });
  return Object.assign(countSelection, { bytes: source.length * 2 + ranges.length * 64 });
}

function countProseText(text: string): ProseCount {
  const prose = text.replace(/\s+/g, " ").trim();
  // Counted in place: arrays of every word and every character would dwarf a long document.
  let words = 0, characters = 0;
  wordPattern.lastIndex = 0;
  while (wordPattern.exec(prose)) words++;
  for (let i = 0; i < prose.length; i++) {
    const unit = prose.charCodeAt(i);
    // A surrogate pair is one character; count its first half only.
    if (unit < 0xDC00 || unit > 0xDFFF) characters++;
  }
  return { words, characters };
}

export function countProse(source: string, selection?: SourceSelection, mdx = false, selectedText?: string): ProseCounts {
  return prepareProseCount(source, mdx)(selection, selectedText);
}

/** One revision per document, within the existing shared byte budget. */
export function createProseCountCache(budget = new CacheBudget()) {
  const documents = new ByteCache<{ revision: number; mdx: boolean; count: ReturnType<typeof prepareProseCount> }>(budget);
  return (id: number, revision: number, source: string, selection?: SourceSelection, mdx = false, selectedText?: string) => {
    let cached = documents.get(String(id));
    if (!cached || cached.revision !== revision || cached.mdx !== mdx) {
      cached = { revision, mdx, count: prepareProseCount(source, mdx) };
      documents.set(String(id), cached, cached.count.bytes);
    }
    return cached.count(selection, selectedText);
  };
}

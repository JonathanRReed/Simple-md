import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { parser, GFM } from "@lezer/markdown";
import { findMdxRanges } from "./mdx-ranges.js";
import { jsxContentBounds } from "./mdx-preview.js";
import { sourceLines, type SourceSelection } from "../renderer/source-edit.js";

export type { ProseCount, ProseCounts } from "./prose-count-result.js";
import type { ProseCount, ProseCounts } from "./prose-count-result.js";
const markdown = parser.configure(GFM);
const excluded = new Set(["FencedCode", "CodeBlock", "HTMLTag", "LinkMark", "URL", "LinkTitle", "EmphasisMark", "CodeMark", "HeaderMark", "QuoteMark", "ListMark", "TaskMarker", "TableDelimiter", "TableMark", "HorizontalRule", "LinkReference", "Escape"]);
const wordPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Parser ranges remove non-prose; counting runs only in the counter worker. */
export function countProse(source: string, selection?: SourceSelection, mdx = false, selectedText?: string): ProseCounts {
  const lines = sourceLines(source);
  const ranges: { from: number; to: number; insert?: string }[] = [];
  if (source.startsWith("\uFEFF")) ranges.push({ from: 0, to: 1 });
  if (lines[0]?.text === "---") {
    const end = lines.findIndex((line, index) => index > 0 && (line.text === "---" || line.text === "..."));
    if (end > 0) ranges.push({ from: lines[0].from, to: lines[end]!.end });
  }
  const mdxRanges = mdx ? findMdxRanges(source) : undefined;
  if (mdxRanges?.error) ranges.push({ from: mdxRanges.error.start, to: mdxRanges.error.end });
  if (mdxRanges) for (const range of mdxRanges) {
    if ((range.kind === "jsx-flow" || range.kind === "jsx-text") && range.name !== "script" && range.name !== "style") {
      const { end, innerEnd } = jsxContentBounds(source, range);
      ranges.push({ from: range.start, to: end }, { from: innerEnd, to: range.end });
    } else ranges.push({ from: range.start, to: range.end });
  }
  // Mask imports/JSX before Markdown parsing so JSX children remain Markdown prose.
  const chars = source.split("");
  for (const range of ranges) for (let i = range.from; i < range.to; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = i === range.from || source[i - 1] === "\n" || source[i - 1] === "\r" ? "x" : " ";
  const masked = chars.join("");
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
  return { document, ...(selectedText !== undefined ? { selection: countProseText(selectedText) } : selection && selection.from !== selection.to ? { selection: count(selection.from, selection.to) } : {}), minutes: Math.max(1, Math.ceil(document.words / 230)) };
}

function countProseText(text: string): ProseCount {
  const prose = text.replace(/\s+/g, " ").trim();
  return { words: [...prose.matchAll(wordPattern)].length, characters: [...prose].length };
}

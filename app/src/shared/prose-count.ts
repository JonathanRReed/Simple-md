import { createMarkdownParser } from "./markdown-parser.js";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { parser, GFM } from "@lezer/markdown";
import { findMdxRanges } from "./mdx-ranges.js";
import { jsxContentBounds } from "./mdx-preview.js";
import { sourceLines, type SourceSelection } from "../renderer/source-edit.js";

export type { ProseCount, ProseCounts } from "./prose-count-result.js";
import type { ProseCount, ProseCounts } from "./prose-count-result.js";
const markdown = parser.configure(GFM);
const footnotes = createMarkdownParser();
const excluded = new Set(["FencedCode", "CodeBlock", "HTMLTag", "LinkMark", "URL", "LinkTitle", "LinkLabel", "EmphasisMark", "CodeMark", "HeaderMark", "QuoteMark", "ListMark", "TaskMarker", "TableDelimiter", "TableMark", "HorizontalRule", "LinkReference", "Escape"]);
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
  const mask = (range: { from: number; to: number }) => {
    for (let i = range.from; i < range.to; i++) {
      if (chars[i] === "\n" || chars[i] === "\r") continue;
      chars[i] = i === 0 && source[i] === "\uFEFF" ? " " : i === range.from || source[i - 1] === "\n" || source[i - 1] === "\r" ? "x" : " ";
    }
  };
  ranges.forEach(mask);
  let masked = chars.join("");
  if (source.includes("[^")) {
    const env: { footnotes?: { refs?: Record<string, unknown> } } = {};
    const tokens = footnotes.parse(masked, env);
    let note = false;
    // The renderer parser owns footnote boundaries and continuation indentation.
    for (const token of tokens) {
      if (token.type === "footnote_open") note = true;
      if (token.type === "footnote_close") note = false;
      if (!note || token.type !== "inline" || !token.map) continue;
      const content = token.content.split("\n");
      for (let i = 0; i < content.length; i++) {
        const line = lines[token.map[0] + i], piece = content[i]!;
        if (!line || !piece) continue;
        const at = line.text.indexOf(piece);
        if (at <= 0) continue;
        const range = { from: line.from, to: line.from + at };
        ranges.push(range); mask(range);
      }
    }
    const literal = ranges.map(range => ({ from: range.from, to: range.to }));
    markdown.parse(chars.join("")).iterate({ enter(node) {
      if (["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "HTMLTag", "Escape"].includes(node.name)) { literal.push({ from: node.from, to: node.to }); return false; }
    } });
    literal.sort((a, b) => a.from - b.from);
    let index = 0, end = 0;
    for (const match of source.matchAll(/\[\^([^\]\s]+)\]/g)) {
      while (index < literal.length && literal[index]!.from <= match.index) end = Math.max(end, literal[index++]!.to);
      if (match.index < end || !Object.hasOwn(env.footnotes?.refs ?? {}, ":" + match[1])) continue;
      const line = lines.find(line => match.index >= line.from && match.index <= line.to)!;
      const definition = /^[ \t>]*$/.test(source.slice(line.from, match.index)) ? /^:[ \t]*/.exec(source.slice(match.index + match[0].length))?.[0].length ?? 0 : 0;
      const range = { from: match.index, to: match.index + match[0].length + definition };
      ranges.push(range); mask(range);
    }
    masked = chars.join("");
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
  return { document, ...(selectedText !== undefined ? { selection: countProseText(selectedText) } : selection && selection.from !== selection.to ? { selection: count(selection.from, selection.to) } : {}), minutes: Math.max(1, Math.ceil(document.words / 230)) };
}

function countProseText(text: string): ProseCount {
  const prose = text.replace(/\s+/g, " ").trim();
  return { words: [...prose.matchAll(wordPattern)].length, characters: [...prose].length };
}

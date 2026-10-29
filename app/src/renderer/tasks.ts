import type { MdxRange } from "../shared/mdx-ranges.js";
import { jsxContentBounds } from "../shared/mdx-preview.js";
import { createMarkdownParser } from "../shared/markdown-parser.js";

const parser = createMarkdownParser();

export function toggleTaskAt(text: string, ordinal: number, ranges?: readonly MdxRange[]): string | null {
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const source = text.slice(bom);
  const frontmatter = /^---(?:\r\n|\r|\n)[\s\S]*?(?:\r\n|\r|\n)---(?:(?:\r\n|\r|\n)|$)/.exec(source)?.[0].length ?? 0;
  const offset = bom + frontmatter;
  const body = text.slice(offset);
  const starts = [0];
  for (const match of body.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  let parsedBody = body;
  if (ranges) {
    const characters = text.split("");
    const mask = (from: number, to: number) => {
      for (let at = from; at < to; at++) if (characters[at] !== "\r" && characters[at] !== "\n") characters[at] = " ";
    };
    for (const range of ranges) {
      if ((range.kind === "jsx-flow" || range.kind === "jsx-text") && range.name !== "style" && range.name !== "script") {
        const { end, innerEnd } = jsxContentBounds(text, range);
        mask(range.start, end);
        mask(innerEnd, range.end);
      } else mask(range.start, range.end);
    }
    parsedBody = characters.join("").slice(offset);
  }
  let index = 0;
  for (const token of parser.parse(parsedBody, {})) {
    if (token.type !== "inline" || token.children?.[0]?.type !== "checkbox_input" || !token.map) continue;
    if (index++ !== ordinal) continue;
    const lineStart = starts[token.map[0]]!;
    const line = body.slice(lineStart, starts[token.map[0] + 1] ?? body.length).replace(/[\r\n]+$/, "");
    const marker = line.indexOf(token.content.slice(0, 3));
    if (marker < 0) return null;
    const at = offset + lineStart + marker + 1;
    return text.slice(0, at) + (/[xX]/.test(text[at]!) ? " " : "x") + text.slice(at + 1);
  }
  return null;
}

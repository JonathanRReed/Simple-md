import { createMarkdownParser } from "../shared/markdown-parser.js";

const parser = createMarkdownParser();

export function toggleTaskAt(text: string, ordinal: number): string | null {
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const source = text.slice(bom);
  const frontmatter = /^---(?:\r\n|\r|\n)[\s\S]*?(?:\r\n|\r|\n)---(?:(?:\r\n|\r|\n)|$)/.exec(source)?.[0].length ?? 0;
  const offset = bom + frontmatter;
  const body = text.slice(offset);
  const starts = [0];
  for (const match of body.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  let index = 0;
  for (const token of parser.parse(body, {})) {
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

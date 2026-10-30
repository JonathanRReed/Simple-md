import type { MdxRange } from "./mdx-ranges.js";
import type { RenderNode } from "./render-tree.js";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const expression = (source: string): RenderNode => ({
  kind: "app", parts: [`<span class="mdx-expression"><span class="mdx-label">Expression</span> <code>${escape(source)}</code></span>`],
});
export interface MdxPreview { text: string; nodes: Map<string, RenderNode>; lineMap: number[]; endLine: number }

export function jsxContentBounds(source: string, range: Extract<MdxRange, { name: string | null }>) {
  // Skip quoted attributes and parser-delimited expressions when finding the tag end.
  let quote = "";
  let end = range.start;
  for (; end < range.end; end++) {
    const expression = range.syntax.find((span) => span.kind === "expression" && span.start === end);
    if (expression) { end = expression.end - 1; continue; }
    const char = source[end]!;
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") { end++; break; }
  }
  const selfClosing = /\/\s*>$/.test(source.slice(range.start, end));
  const innerEnd = selfClosing ? end : Math.max(end, source.lastIndexOf("</", range.end));
  return { end, innerEnd, selfClosing };
}

/** Positions come only from the MDX tokenizer. Placeholders cannot collide with author text. */
export async function mapMdxPreview(
  source: string,
  ranges: readonly MdxRange[],
  render: (preview: MdxPreview, inline: boolean) => Promise<RenderNode>,
): Promise<MdxPreview> {
  let prefix = "SIMPLEMDMDX";
  while (source.includes(prefix)) prefix += "X";
  let sequence = 0;
  const starts = [0];
  for (const match of source.matchAll(/\r\n|[\r\n]/g)) starts.push(match.index + match[0].length);
  function lineAt(offset: number): number {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  async function section(from: number, to: number, children: readonly MdxRange[], depth = 0): Promise<MdxPreview> {
    const nodes = new Map<string, RenderNode>();
    const parts: string[] = [];
    let originalLine = lineAt(from);
    const lineMap = [originalLine];
    const append = (text: string) => {
      parts.push(text);
      for (const _ of text.matchAll(/\r\n|[\r\n]/g)) lineMap.push(++originalLine);
    };
    let cursor = from;
    for (const range of children) {
      if (range.start < cursor || range.start < from || range.end > to) continue;
      append(source.slice(cursor, range.start));
      const raw = source.slice(range.start, range.end);
      let node: RenderNode | undefined;
      if (depth >= 128) {
        node = { kind: "app", parts: [`<span class="mdx-depth-limit">Nested MDX shown as source</span><code>${escape(raw)}</code>`] };
      } else if (range.kind === "expression-flow" || range.kind === "expression-text") {
        node = expression(raw);
      } else if (range.kind === "jsx-flow" || range.kind === "jsx-text") {
        if (range.name !== "script" && range.name !== "style") {
          const { end, innerEnd, selfClosing } = jsxContentBounds(source, range);
          const attributesAsSource = range.syntax.filter((span) => span.kind === "expression" && span.start < end).map((span) => expression(source.slice(span.start, span.end)));
          const nested = children.filter((child) => child !== range && child.start >= end && child.end <= innerEnd);
          const child = await render(await section(end, innerEnd, nested, depth + 1), range.kind === "jsx-text");
          if (range.capitalized) {
            const tag = range.kind === "jsx-text" ? "span" : "div";
            node = { kind: "app", parts: [`<${tag} class="mdx-component"><span class="mdx-label">${escape(range.name!)}</span> `, ...attributesAsSource, child, `</${tag}>`] };
          } else if (range.name === null) {
            node = child;
          } else {
            // Keep static author attributes only. DOMPurify applies the same policy as .md.
            const attributes = range.syntax.filter((span) => span.kind === "attribute" && span.start < end).map((span) => {
              const name = source.slice(span.start, span.end);
              if (name === "className") return ""; // Author classes are forbidden by policy.
              const value = /^\s*=\s*("[^"]*"|'[^']*')/.exec(source.slice(span.end, end));
              if (value) return ` ${name}=${value[1]}`;
              if (/^\s*=/.test(source.slice(span.end, end))) return "";
              return ` ${name}=""`;
            }).join("");
            node = { kind: "author", parts: [`<${range.name}${attributes}>`, ...attributesAsSource, child, selfClosing ? "" : `</${range.name}>`] };
          }
        }
      }
      if (node) {
        const marker = `@${prefix}${sequence++}END@`;
        nodes.set(marker, node);
        parts.push(marker);
      }
      // Collapse only the positioned range. Keep an explicit map to original lines,
      // so multiline inline JSX cannot introduce paragraph breaks in surrounding text.
      originalLine = lineAt(range.end);
      cursor = range.end;
    }
    append(source.slice(cursor, to));
    return { text: parts.join(""), nodes, lineMap, endLine: lineAt(Math.max(from, to - 1)) + 1 };
  }
  return section(0, source.length, ranges);
}

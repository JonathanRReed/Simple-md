import type { MdxRange } from "./mdx-ranges.js";
import type { RenderNode } from "./render-tree.js";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export interface MdxPreview { text: string; nodes: Map<string, RenderNode>; lines: Map<string, number> }

/** Positions come only from the MDX tokenizer. Placeholders cannot collide with author text. */
export async function mapMdxPreview(
  source: string,
  ranges: readonly MdxRange[],
  render: (preview: MdxPreview, inline: boolean) => Promise<RenderNode>,
): Promise<MdxPreview> {
  let prefix = "SIMPLEMDMDX";
  while (source.includes(prefix)) prefix += "X";
  let sequence = 0;

  async function section(from: number, to: number, children: readonly MdxRange[]): Promise<MdxPreview> {
    const nodes = new Map<string, RenderNode>();
    const lines = new Map<string, number>();
    const parts: string[] = [];
    let cursor = from;
    for (const range of children) {
      if (range.start < cursor || range.start < from || range.end > to) continue;
      parts.push(source.slice(cursor, range.start));
      const raw = source.slice(range.start, range.end);
      let node: RenderNode | undefined;
      if (range.kind === "expression-flow" || range.kind === "expression-text") {
        node = { kind: "app", parts: [`<span class="mdx-expression"><span class="mdx-label">Expression</span> <code>${escape(raw)}</code></span>`] };
      } else if (range.kind === "jsx-flow" || range.kind === "jsx-text") {
        if (range.name !== "script" && range.name !== "style") {
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
          const opening = source.slice(range.start, end);
          const selfClosing = /\/\s*>$/.test(opening);
          const close = selfClosing ? end : source.lastIndexOf("</", range.end);
          const innerEnd = Math.max(end, close);
          const nested = children.filter((child) => child !== range && child.start >= end && child.end <= innerEnd);
          const child = await render(await section(end, innerEnd, nested), range.kind === "jsx-text");
          if (range.capitalized) {
            const tag = range.kind === "jsx-text" ? "span" : "div";
            node = { kind: "app", parts: [`<${tag} class="mdx-component"><span class="mdx-label">${escape(range.name!)}</span>`, child, `</${tag}>`] };
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
            node = { kind: "author", parts: [`<${range.name}${attributes}>`, child, selfClosing ? "" : `</${range.name}>`] };
          }
        }
      }
      if (node) {
        const marker = `@${prefix}${sequence++}END@`;
        nodes.set(marker, node);
        lines.set(marker, 1 + (raw.match(/\r\n|[\r\n]/g)?.length ?? 0));
        parts.push(marker);
      }
      // Retain every source line for markdown-it token.map and block ranges.
      parts.push(raw.replace(/[^\r\n]/g, ""));
      cursor = range.end;
    }
    parts.push(source.slice(cursor, to));
    return { text: parts.join(""), nodes, lines };
  }
  return section(0, source.length, ranges);
}

import type { MarkdownIt, Token } from "markdown-it";

export interface InlineMath { from: number; to: number; source: string; raw: string }

/** Shared by the render parser and Live. Offsets refer to the supplied source. */
export function inlineMath(source: string): InlineMath[] {
  const pattern = /(?<![\\\w$])(?<marker>\$\$?)(?![\s$])(?<source>[^$\n]*?[^\s$])\k<marker>(?![\w$])/g;
  const code = [...source.matchAll(/(?<![\\\w$])\$(`+)([^\n]*?)\1\$(?![\w$])/g)].map(match => ({
    from: match.index, to: match.index + match[0].length, source: match[2]!, raw: match[0],
  }));
  const plain = [...source.matchAll(pattern)].filter(match => {
    if (code.some(range => range.from < match.index + match[0].length && range.to > match.index)) return false;
    const text = match.groups!.source!;
    let slashes = 0;
    for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    return slashes % 2 === 0;
  }).map(match => ({ from: match.index, to: match.index + match[0].length, source: match.groups!.source!, raw: match[0] }));
  return [...code, ...plain].sort((a, b) => a.from - b.from);
}

export function displayMathAt(line: number, endLine: number, getLine: (line: number) => string | null): { end: number; source: string } | null {
  const first = getLine(line)?.trim();
  if (!first?.startsWith("$$")) return null;
  if (first.slice(2).includes("$$") && !first.endsWith("$$")) return null;
  let end = line;
  let content = first.slice(2);
  if (!content.endsWith("$$")) {
    const lines = [content];
    for (end = line + 1; end < endLine; end++) {
      const next = getLine(end)?.trim();
      if (!next) return null;
      lines.push(next);
      if (next.endsWith("$$")) break;
      if (next.includes("$$")) return null;
    }
    if (end === endLine) return null;
    content = lines.join("\n");
  }
  if (content.slice(0, -2).includes("$$")) return null;
  if (end + 1 < endLine && getLine(end + 1)?.trim()) return null;
  return { end, source: content.slice(0, -2).trim() };
}

let renderToString: typeof import("katex").renderToString | undefined;

export async function prepareMath(tokens: Token[]): Promise<void> {
  const hasMath = (items: Token[]): boolean => items.some(token => token.type === "math_inline" || token.type === "math_block" ||
    token.type === "fence" && token.info.trim() === "math" || token.children !== null && hasMath(token.children));
  if (!renderToString && hasMath(tokens)) renderToString = (await import("katex")).renderToString;
}

export function githubMath(md: MarkdownIt): void {
  const render = (source: string, displayMode: boolean) => renderToString!(source, {
    displayMode, throwOnError: false, trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000,
    // A fresh macro table prevents definitions from leaking into another equation or document.
    macros: {},
  });
  md.core.ruler.before("text_join", "github_literal_dollars", (state) => {
    for (const token of state.tokens) for (const child of token.children ?? []) {
      if (child.type === "text_special" && child.markup === "\\$" ) child.type = "github_literal";
    }
  });
  md.renderer.rules.github_literal = (tokens, i) => md.utils.escapeHtml(tokens[i]!.content);
  md.core.ruler.push("github_inline_math", (state) => {
    for (const block of state.tokens) {
      if (!block.children || !block.content.includes("$")) continue;
      // GitHub leaves "$$…$$ trailing text" at the start of a paragraph as text.
      const matches = inlineMath(block.content).filter(match => !match.raw.startsWith("$$") || match.from > 0);
      const codeCandidates = new Set(matches.map(match => match.raw));
      const candidates = new Set(matches.map(match => md.utils.unescapeAll(match.raw)));
      let codeDepth = 0;
      for (let i = 0; i < block.children.length - 2; i++) {
        const token = block.children[i]!;
        if (token.type === "html_inline" && /^<\/?(?:code|pre)\b/i.test(token.content)) codeDepth += token.content.startsWith("</") ? -1 : 1;
        const code = block.children[i + 1]!;
        const tail = block.children[i + 2]!;
        if (!codeDepth && token.type === "text" && token.content.endsWith("$") && code.type === "code_inline" && tail.type === "text" && tail.content.startsWith("$") && codeCandidates.has(`$${code.markup}${code.content}${code.markup}$`)) {
          token.content = token.content.slice(0, -1);
          code.type = "math_inline";
          code.tag = "math";
          tail.content = tail.content.slice(1);
        }
      }
      const result: typeof block.children = [];
      codeDepth = 0;
      for (const token of block.children) {
        if (token.type === "html_inline" && /^<\/?(?:code|pre)\b/i.test(token.content)) codeDepth += token.content.startsWith("</") ? -1 : 1;
        if (codeDepth || token.type !== "text" || !token.content.includes("$")) { result.push(token); continue; }
        let start = 0;
        for (const match of inlineMath(token.content)) {
          if (!candidates.has(match.raw)) continue;
          if (match.from > start) {
            const text = new state.Token("text", "", 0);
            text.content = token.content.slice(start, match.from);
            result.push(text);
          }
          const math = new state.Token("math_inline", "math", 0);
          math.content = match.source;
          result.push(math);
          start = match.to;
        }
        if (start < token.content.length) {
          const text = new state.Token("text", "", 0);
          text.content = token.content.slice(start);
          result.push(text);
        }
      }
      block.children = result;
    }
  });
  md.block.ruler.before("fence", "github_math", (state, line, endLine, silent) => {
    if (state.sCount[line]! - state.blkIndent >= 4) return false;
    const match = displayMathAt(line, endLine, n => state.sCount[n]! < state.blkIndent ? null : state.src.slice(state.bMarks[n]! + state.tShift[n]!, state.eMarks[n]!));
    if (!match) return false;
    const { end } = match;
    if (silent) return true;
    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.map = [line, end + 1];
    token.content = end === line ? md.utils.unescapeAll(match.source) : match.source;
    state.line = end + 1;
    return true;
  });
  md.renderer.rules.math_inline = (tokens, i) => render(tokens[i]!.content, false);
  md.renderer.rules.math_block = (tokens, i) => render(tokens[i]!.content, true) + "\n";
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, i, options, env, self) => tokens[i]!.info.trim() === "math"
    ? render(tokens[i]!.content.trim(), true) + "\n" : fence(tokens, i, options, env, self);
}

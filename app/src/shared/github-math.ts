import type { MarkdownIt, Token } from "markdown-it";

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
      const pattern = /(?<![\w$])(?<marker>\$\$?)(?![\s$])(?<source>[^$\n]*?[^\s$])\k<marker>(?![\w$])/g;
      const candidates = new Set([...block.content.matchAll(pattern)]
        .filter((match) => match.groups!.marker !== "$$" || match.index > 0)
        .map((match) => md.utils.unescapeAll(match[0])));
      let codeDepth = 0;
      for (let i = 0; i < block.children.length - 2; i++) {
        const token = block.children[i]!;
        if (token.type === "html_inline" && /^<\/?(?:code|pre)\b/i.test(token.content)) codeDepth += token.content.startsWith("</") ? -1 : 1;
        const code = block.children[i + 1]!;
        const tail = block.children[i + 2]!;
        if (!codeDepth && token.type === "text" && token.content.endsWith("$") && code.type === "code_inline" && tail.type === "text" && tail.content.startsWith("$")) {
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
        for (const match of token.content.matchAll(pattern)) {
          if (!candidates.has(match[0])) continue;
          if (match.index > start) {
            const text = new state.Token("text", "", 0);
            text.content = token.content.slice(start, match.index);
            result.push(text);
          }
          const math = new state.Token("math_inline", "math", 0);
          math.content = match.groups!.source!;
          result.push(math);
          start = match.index + match[0].length;
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
    const first = state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!).trim();
    if (!first.startsWith("$$") || state.sCount[line]! - state.blkIndent >= 4) return false;
    if (first.slice(2).includes("$$") && !first.endsWith("$$")) return false;
    let end = line;
    let content = first.slice(2);
    if (!content.endsWith("$$")) {
      const lines = [content];
      for (end = line + 1; end < endLine; end++) {
        const next = state.src.slice(state.bMarks[end]! + state.tShift[end]!, state.eMarks[end]!).trim();
        if (!next || state.sCount[end]! < state.blkIndent) return false;
        lines.push(next);
        if (next.endsWith("$$")) break;
        if (next.includes("$$")) return false;
      }
      if (end === endLine) return false;
      content = lines.join("\n");
    }
    if (content.slice(0, -2).includes("$$")) return false;
    const following = state.src.slice(state.bMarks[end + 1] ?? state.src.length, state.eMarks[end + 1] ?? state.src.length).trim();
    if (following && end + 1 < endLine) return false;
    if (silent) return true;
    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.map = [line, end + 1];
    token.content = end === line ? md.utils.unescapeAll(content.slice(0, -2).trim()) : content.slice(0, -2).trim();
    state.line = end + 1;
    return true;
  });
  md.renderer.rules.math_inline = (tokens, i) => render(tokens[i]!.content, false);
  md.renderer.rules.math_block = (tokens, i) => render(tokens[i]!.content, true) + "\n";
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, i, options, env, self) => tokens[i]!.info.trim() === "math"
    ? render(tokens[i]!.content.trim(), true) + "\n" : fence(tokens, i, options, env, self);
}

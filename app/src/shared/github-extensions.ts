import type { MarkdownIt, Token } from "markdown-it";
import { nameToEmoji } from "gemoji";

export function githubExtensions(md: MarkdownIt): void {
  md.core.ruler.before("inline", "github_image_paragraphs", (state) => {
    state.tokens = state.tokens.flatMap((token) => {
      if (token.type !== "html_block" || !/^\s*<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>\s*$/i.test(token.content)) return [token];
      // GitHub's attachment embed is a block, unlike an ordinary inline HTML image.
      if (/https:\/\/github\.com\/(?:user-attachments\/assets\/|[^/]+\/[^/]+\/assets\/)/.test(token.content)) return [token];
      const open = new state.Token("paragraph_open", "p", 1);
      open.map = token.map;
      const inline = new state.Token("inline", "", 0);
      inline.content = token.content.trim();
      inline.map = token.map;
      inline.children = [];
      return [open, inline, new state.Token("paragraph_close", "p", -1)];
    });
  });
  md.core.ruler.before("inline", "github_table_whitespace", (state) => {
    let row: number | undefined;
    let column = 0;
    let cells: string[] = [];
    let lines: string[] | undefined;
    for (const token of state.tokens) {
      if (token.type === "tr_open" && token.map) {
        row = token.map[0];
        column = 0;
        lines ??= state.src.split("\n");
        const line = lines[row]!.replace(/^[ \t]+|[ \t]+$/g, "");
        // Match markdown-it's escaped-pipe splitting while retaining Unicode spaces.
        cells = line.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|"));
        if (cells[0] === "") cells.shift();
        if (cells.at(-1) === "") cells.pop();
      } else if (token.type === "tr_close") row = undefined;
      else if (row !== undefined && token.type === "inline") {
        const cell = (cells[column++] ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
        if (cell.trim() === token.content) token.content = cell;
      }
    }
  });
  // Keep markdown-it's delimiter pairing, with distinct markers for one and two tildes.
  md.inline.ruler.at("strikethrough", (state, silent) => {
    if (silent || state.src[state.pos] !== "~") return false;
    const run = state.scanDelims(state.pos, true);
    if (run.length > 2) { state.pending += "~".repeat(run.length); state.pos += run.length; return true; }
    const token = state.push("text", "", 0);
    token.content = "~".repeat(run.length);
    state.delimiters.push({ marker: run.length === 1 ? 126 : 127, length: 0,
      token: state.tokens.length - 1, end: -1, open: run.can_open, close: run.can_close });
    state.pos += run.length;
    return true;
  });
  md.inline.ruler2.at("strikethrough", (state) => {
    const process = (delimiters: typeof state.delimiters) => {
      for (const start of delimiters) {
        if ((start.marker !== 126 && start.marker !== 127) || start.end < 0) continue;
        const end = delimiters[start.end]!;
        for (const [index, nesting] of [[start.token, 1], [end.token, -1]] as const) {
          const token = state.tokens[index]!;
          token.type = nesting === 1 ? "s_open" : "s_close";
          token.tag = "del";
          token.nesting = nesting;
          token.markup = "~".repeat(start.marker === 126 ? 1 : 2);
          token.content = "";
        }
      }
    };
    process(state.delimiters);
    for (const meta of state.tokens_meta) if (meta?.delimiters) process(meta.delimiters);
  });
  md.core.ruler.push("github_emoji_and_markup", (state) => {
    let codeDepth = 0;
    const visit = (tokens: Token[]) => {
      for (const token of tokens) {
        if (token.type === "html_inline" && /^<\/?(?:code|pre)\b/i.test(token.content)) codeDepth += token.content.startsWith("</") ? -1 : 1;
        if (!codeDepth && token.type === "text") token.content = token.content.replace(/:([+\w-]+):/g, (all, name: string) => Object.hasOwn(nameToEmoji, name) ? nameToEmoji[name]! : all);
        if (token.type === "checkbox_input") {
          token.attrs = token.attrs?.filter(([key]) => key !== "id") ?? null;
          token.attrSet("aria-label", token.attrGet("checked") === null ? "Incomplete task" : "Completed task");
        }
        if (token.children) visit(token.children);
      }
    };
    visit(state.tokens);
  });
  const image = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, i, options, env, self) => image(tokens, i, options, env, self).replace(/\n/g, " ");
  md.renderer.rules.footnote_ref = (tokens, i) => {
    const id = Number(tokens[i]!.meta?.id);
    const subId = Number(tokens[i]!.meta?.subId ?? 0);
    const suffix = subId ? `-${subId + 1}` : "";
    return `<sup><a href="#user-content-fn-${id + 1}" id="user-content-fnref-${id + 1}${suffix}" data-footnote-ref aria-describedby="user-content-footnote-label">${id + 1}</a></sup>`;
  };
  md.renderer.rules.footnote_block_open = () => '<section class="footnotes" data-footnotes><h2 class="sr-only" id="user-content-footnote-label">Footnotes</h2>\n<ol>\n';
  md.renderer.rules.footnote_open = (tokens, i) => `<li id="user-content-fn-${Number(tokens[i]!.meta?.id) + 1}">`;
  md.renderer.rules.footnote_anchor = (tokens, i) => {
    const id = Number(tokens[i]!.meta?.id);
    const subId = Number(tokens[i]!.meta?.subId ?? 0);
    const suffix = subId ? `-${subId + 1}` : "";
    return ` <a href="#user-content-fnref-${id + 1}${suffix}" data-footnote-backref aria-label="Back to reference ${id + 1}${subId ? `-${subId + 1}` : ""}" class="footnote-backref">↩${subId ? `<sup>${subId + 1}</sup>` : ""}</a>`;
  };
}

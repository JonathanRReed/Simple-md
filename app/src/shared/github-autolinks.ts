import type { MarkdownIt } from "markdown-it";

// GFM 6.9. Bare domains and FTP are deliberately not autolinks.
export function githubAutolinks(md: MarkdownIt): void {
  md.inline.ruler.disable("linkify");
  md.core.ruler.at("linkify", (state) => {
    for (const block of state.tokens) {
      if (!block.children || !/(?:www\.|https?:\/\/|@)/i.test(block.content)) continue;
      const result: typeof block.children = [];
      let linkDepth = 0;
      let literalDepth = 0;
      for (const token of block.children) {
        if (token.type === "link_open") linkDepth++;
        if (token.type === "link_close") linkDepth--;
        if (token.type === "html_inline" && /^<\/?(?:a|code|pre)\b/i.test(token.content)) literalDepth += token.content.startsWith("</") ? -1 : 1;
        if (linkDepth || literalDepth || token.type !== "text") { result.push(token); continue; }
        const matches = /(?:https?:\/\/|www\.)[^\s<>]+|(?:mailto:)?[a-z0-9._+-]+@[a-z0-9_-]+(?:\.[a-z0-9_-]+)+/gi;
        let start = 0;
        for (const match of token.content.matchAll(matches)) {
          let label = match[0];
          const email = !/^(?:https?:\/\/|www\.)/i.test(label);
          if (email) {
            label = label.replace(/\.+$/, "");
            if (/[-_]$/.test(label)) continue;
          } else {
            const before = token.content[match.index - 1];
            if (before && !/[\s*_~(<]/.test(before)) continue;
            label = label.replace(/[?!.,:*_~]+$/, "").replace(/&[a-z0-9]+;$/i, "");
            let excess = (label.match(/\)/g)?.length ?? 0) - (label.match(/\(/g)?.length ?? 0);
            while (excess-- > 0 && label.endsWith(")")) label = label.slice(0, -1);
            label = label.replace(/[?!.,:*_~]+$/, "");
            const domain = label.replace(/^https?:\/\//i, "").split(/[/?#]/)[0]!;
            const segments = domain.replace(/:\d+$/, "").split(".");
            if ((/^www\./i.test(label) && segments.length < 2) || segments.some((s) => !/^[\p{L}\p{N}_-]+$/u.test(s)) || segments.slice(-2).some((s) => s.includes("_"))) continue;
          }
          const href = md.normalizeLink(email ? (/^mailto:/i.test(label) ? label : `mailto:${label}`) : /^www\./i.test(label) ? `http://${label}` : label);
          if (!md.validateLink(href)) continue;
          if (match.index > start) {
            const text = new state.Token("text", "", 0);
            text.content = token.content.slice(start, match.index);
            result.push(text);
          }
          const open = new state.Token("link_open", "a", 1);
          open.attrs = [["href", href]];
          open.markup = "autolink";
          const text = new state.Token("text", "", 0);
          text.content = label;
          result.push(open, text, new state.Token("link_close", "a", -1));
          start = match.index + label.length;
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
}

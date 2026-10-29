import MarkdownIt, { type MarkdownItOptions } from "markdown-it";
import { alert } from "@mdit/plugin-alert";
import { footnote } from "@mdit/plugin-footnote";
import { tasklist } from "@mdit/plugin-tasklist";
import { githubMath } from "./github-math.js";
import { githubExtensions } from "./github-extensions.js";
import { githubAutolinks } from "./github-autolinks.js";

export function createMarkdownParser(highlight?: MarkdownItOptions["highlight"]) {
  return new MarkdownIt({ html: true, linkify: true, typographer: false, highlight })
    .use(githubMath)
    .use(githubAutolinks)
    .use(tasklist, { disabled: true, label: false })
    .use(footnote)
    .use(alert, { titleRenderer: (tokens, i) => {
      const name = String(tokens[i]!.meta?.name ?? tokens[i]!.content).toLowerCase();
      return `<p class="markdown-alert-title">${name[0]?.toUpperCase() ?? ""}${name.slice(1)}</p>\n`;
    } })
    .use(githubExtensions);
}

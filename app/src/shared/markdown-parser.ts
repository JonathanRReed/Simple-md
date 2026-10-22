import MarkdownIt, { type MarkdownItOptions } from "markdown-it";
import { alert } from "@mdit/plugin-alert";
import { footnote } from "@mdit/plugin-footnote";
import { katex } from "@mdit/plugin-katex";
import { tasklist } from "@mdit/plugin-tasklist";

export function createMarkdownParser(highlight?: MarkdownItOptions["highlight"]) {
  return new MarkdownIt({ html: false, linkify: true, typographer: true, highlight })
    .use(katex, { throwOnError: false, trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000 })
    .use(tasklist, { disabled: true })
    .use(footnote)
    .use(alert);
}

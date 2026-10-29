import { createMarkdownParser } from "../../src/shared/markdown-parser";

const parser = createMarkdownParser((code) => {
  // Deliberately small inline-color fixture highlighter, not the app's Shiki renderer.
  const escaped = parser.utils.escapeHtml(code);
  return `<pre style="background:#eeeeee;padding:16px"><code>${escaped.replace(/\b(const|return|function)\b/g, '<span style="color:#a626a4">$1</span>')}</code></pre>`;
});
Object.assign(globalThis, { renderMarkdown: (source: string) => parser.render(source) });

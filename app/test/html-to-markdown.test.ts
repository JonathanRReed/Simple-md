import { expect, test } from "bun:test";
import { htmlToMarkdown } from "../src/shared/html-to-markdown";
import { createMarkdownParser } from "../src/shared/markdown-parser";
const cases: [string, string, string][] = [
  ["headings and paragraphs", "<h1>Title</h1><p>First</p><h6>Last</h6>", "# Title\n\nFirst\n\n###### Last"],
  ["marks", "<p><strong>bold</strong> <em>italic</em> <del>gone</del> <code>a|b</code></p>", "**bold** *italic* ~~gone~~ `a|b`"],
  ["Docs inline styles", '<b style="font-weight:normal"><span style="font-weight:700">Bold</span> <span style="font-style:italic;text-decoration:line-through">gone</span></b>', "**Bold** ~~*gone*~~"],
  ["URLs and images", '<p><a href="https://example.test/a?q=1&amp;b=2">Link</a><img src="https://example.test/a.png" alt="Image"></p>', "[Link](https://example.test/a?q=1&b=2)![Image](https://example.test/a.png)"],
  ["blocked schemes become text", '<a href="javascript:alert(1)">Safe</a><img src="data:text/html,bad" alt="Alt">', "SafeAlt"],
  ["relative image", '<img src="/images/a b.png">', "![](/images/a%20b.png)"],
  ["language and backticks", '<div class="highlight"><pre><code class="language-ts">const a = `x`;\n```\n</code></pre></div>', "````ts\nconst a = `x`;\n```\n````"],
  ["inline backtick", '<code>`x`</code>', "`` `x` ``"],
  ["quote and rule", "<blockquote><p>One</p><p>Two</p></blockquote><hr>", "> One\n>\n> Two\n\n---"],
  ["task list", '<ul class="contains-task-list"><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Todo</li></ul>', "- [x] Done\n- [ ] Todo"],
  ["ordered starts", "<ol start='4'><li>Four</li><li value='8'>Eight</li></ol>", "4. Four\n8. Eight"],
  ["table pipes and alignment", '<table><tr><th>A</th><th style="text-align:right">B</th></tr><tr><td>a|b</td><td><strong>yes</strong></td></tr></table>', "| A | B |\n| --- | ---: |\n| a\\|b | **yes** |"],
  ["unknown elements", "<unknown>Keep <mark>this</mark></unknown>", "Keep this"],
  ["entities and escaping", "<p>&lt;script&gt; &amp; *plain* [word]</p>", "\\<script\\> & \\*plain\\* \\[word\\]"],
  ["empty HTML", "<!--comment--><p></p>", ""],
];
for (const [name, html, markdown] of cases) test(name, () => expect(htmlToMarkdown(html)).toBe(markdown));
const parser = createMarkdownParser();
for (const html of [
  '<ul><li><p>Outer</p><ul><li><p>Inner <strong>bold</strong></p><ol><li>Deep</li></ol></li></ul><p>Tail</p></li><li>Next</li></ul>',
  '<div class="markdown prose"><h2>Chat answer</h2><ol><li><p>First</p><ul><li>Nested</li></ul></li><li>Second</li></ol><pre><code class="language-python">print(1)\n</code></pre></div>',
  '<meta charset="utf-8"><b id="docs-internal-guid-x" style="font-weight:normal"><p dir="ltr"><span style="font-weight:700">Title</span></p><p><span>A&nbsp;paragraph</span></p></b>',
]) test(`messy output retains nested content: ${html.slice(0, 35)}`, () => {
  const converted = htmlToMarkdown(html);
  const tokens = parser.parse(converted, {});
  const rendered = parser.renderer.render(tokens, parser.options, {});
  expect(converted).not.toContain("<");
  if (html.includes("Deep")) {
    expect(rendered).toContain("<ol>"); expect(rendered).toContain("<ul>"); expect(rendered).toContain("Deep"); expect(rendered).toContain("Tail");
    expect(tokens.filter(token => token.type === "list_item_open").map(token => token.level)).toEqual([1, 3, 5, 1]);
  }
  if (html.includes("language-python")) expect(converted).toContain("```python\nprint(1)\n```");
  if (html.includes("docs-internal")) expect(converted).toBe("**Title**\n\nA paragraph");
});

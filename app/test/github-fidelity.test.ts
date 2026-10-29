import { expect, test } from "bun:test";
import { createRenderCore } from "../src/shared/render-core";
import { resolveAuthorUrl } from "../src/shared/url-resolver";

const core = createRenderCore({ urls: () => ({ baseUrl: "file:///project/docs/", rootUrl: "file:///project/" }) });
const html = async (source: string) => (await core.renderMarkdown(source, "/project/docs/readme.md")).html;

test("GFM keeps punctuation and recognizes www and extended email without fuzzy domains", async () => {
  const result = await html('"quotes" -- --- ...\n\n<www.example.org> www.example.org/a(b)). a.b-c_d@a_b.example.org. http://localhost:3000\n\nexample.org a@b.c- a@b.c_ `www.code.org` [www.label.org](next.md)');
  expect(result).toContain('&quot;quotes&quot; -- --- ...');
  for (const href of ["http://www.example.org", "http://www.example.org/a(b)", "mailto:a.b-c_d@a_b.example.org", "http://localhost:3000"]) expect(result).toContain(`href="${href}"`);
  expect(result.match(/<a /g)).toHaveLength(5);
  expect(result).toContain('<code dir="ltr">www.code.org</code>');
  expect(result).toContain('href="file:///project/docs/next.md"');
});

test("single and double tilde delimiters pair by length and leave longer runs literal", async () => {
  const result = await html("~one~ ~~two~~ ~**bold**~ ~mismatch~~ ~~~literal~~~");
  expect(result).toContain("<del>one</del>");
  expect(result).toContain("<del>two</del>");
  expect(result).toContain("<del><strong>bold</strong></del>");
  expect(result).toContain("~mismatch~~ ~~~literal~~~");
});

test("GFM table cells preserve Unicode space, escaped pipes and padding", async () => {
  const result = await html("| a | b |\n| :--- | ---: |\n| `x\\|y` | **value**    | extra |\n| only |\n");
  expect(result).toContain('<th style="text-align:left">a</th>');
  expect(result).toContain('<code dir="ltr">x|y</code>');
  expect(result).toContain("<strong>value</strong>   ");
  expect(result).not.toContain("extra");
  expect(result).toContain('<td style="text-align:right"></td>');
  expect(await html("a | b\n--- | --- | ---\nx | y")).not.toContain("<table");
  expect(await html("> | a | b |\n> | --- | --- |\n> | x | y |")).toContain("<td>x</td>");
});

test("parsed heading text uses github-slugger Unicode and collision rules", async () => {
  const result = await html("# [Hello](next.md) **world** `code` <em>text</em> ![omit](a.png) :smile:\n\n# 😄\n\n# 😄\n\n# Café\n\n# Café\n\n# Café-1\n\n# A　B");
  const ids = [...result.matchAll(/<h\d[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toEqual(["user-content-hello-world-code-text--", "user-content-", "user-content--1", "user-content-café", "user-content-café-1", "user-content-café-1-1", "user-content-ab"]);
});

test("Unicode emoji expand from GitHub aliases while code and custom images stay text", async () => {
  const result = await html(":smile: :it: :label: :+1: :octocat: :unknown:\n\n`:smile:`\n\n<code>:smile:</code>");
  expect(result).toContain("😄 🇮🇹 🏷️ 👍 :octocat: :unknown:");
  expect(result).toContain('<code dir="ltr">:smile:</code>');
  expect(result).toContain("<code>:smile:</code>");
});

test("all GitHub math forms render with source annotations and isolated macros", async () => {
  const result = await html("Inline $x$ and $`\\sqrt{\\$4}`$.\n\n$$\n\\begin{matrix}1 & 2 \\\\ 3 & 4\\end{matrix}\n$$\n\n```math\n\\sqrt{x+2}\n```\n\nEscaped \\$x\\$ and `$y$`.\n\n<code>$z$</code>\n\n$\\gdef\\mymacro{secret}\\mymacro$\n\n$\\mymacro$");
  expect(result.match(/class="katex-display"/g)).toHaveLength(2);
  expect(result).toContain('encoding="application/x-tex">x</annotation>');
  expect(result).toContain('encoding="application/x-tex">\\sqrt{\\$4}</annotation>');
  expect(result).toContain("Escaped $x$ and");
  expect(result).toContain('<code dir="ltr">$y$</code>');
  expect(result).toContain("<code>$z$</code>");
  expect(result).toContain("\\mymacro");
  expect(result).not.toContain('href="secret"');
  expect(await html("$\\href{https://example.org}{unsafe}$")).not.toContain("<a ");
});

test("references share URL resolution and footnotes preserve first-use order and repeated backrefs", async () => {
  const result = await html("[Next][n] ![Image][i]\n\nFirst[^b], repeat[^b], second[^a].\n\n[n]: other.md#Caf%C3%A9\n[i]: image.png#gh-dark-mode-only\n[^a]: Alpha\n[^b]: Bravo");
  expect(result).toContain('href="file:///project/docs/other.md#Caf%C3%A9"');
  expect(result).toContain('src="file:///project/docs/image.png#gh-dark-mode-only"');
  expect(result).toContain('id="user-content-fnref-1-2"');
  expect(result).toContain('href="#user-content-fnref-1-2"');
  expect(result).toContain('aria-label="Back to reference 1-2"');
  expect(result.indexOf("Bravo")).toBeLessThan(result.indexOf("Alpha"));
  expect(resolveAuthorUrl("other.md#section", "anchor", { baseUrl: "file:///project/docs/" })).toBe("file:///project/docs/other.md#section");
  expect(resolveAuthorUrl("https://github.com/owner/repo/blob/main/image.svg#gh-light-mode-only", "resource")).toBe("https://github.com/owner/repo/raw/main/image.svg#gh-light-mode-only");
});

test("frontmatter becomes inert GitHub tables with bounded YAML aliases and escaped values", async () => {
  const result = await html('---\ntitle: Test\ntags: [one, two]\nnested: {key: "<img onerror=x>"}\n---\nBody');
  expect(result).toContain("<th>title</th><td>Test</td>");
  expect(result).toContain("<td><div>one</div></td><td><div>two</div></td>");
  expect(result).toContain("&lt;img onerror=x&gt;");
  expect(result).not.toContain("<img");
  expect(await html("---\na: &a [*a]\n---\nBody")).toContain("<pre>");
});

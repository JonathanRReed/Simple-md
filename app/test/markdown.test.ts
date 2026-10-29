import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderBlocks, renderFragment, renderMarkdown } from "../src/main/markdown";

const html = async (src: string, file: string | null = "/tmp/note.md") => (await renderMarkdown(src, file)).html;

describe("basics", () => {
  test("headings get GitHub-style prefixed ids, with duplicate suffixes", async () => {
    const out = await html("# Hello, World!\n\n## Hello, World!\n");
    expect(out).toContain('id="user-content-hello-world"');
    expect(out).toContain('id="user-content-hello-world-1"');
  });

  test("explicit numeric heading suffixes cannot collide with generated ids", async () => {
    const out = await html("# Topic\n\n# Topic\n\n# Topic-1\n\n# Topic");
    const ids = [...out.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["user-content-topic", "user-content-topic-1", "user-content-topic-1-1", "user-content-topic-2"]);
  });

  test("heading links and formatting use visible text for fragment ids", async () => {
    const out = await html("# [Introduction](https://example.com)\n\n## **Strong** and `code`\n\n[Jump](#introduction)");
    expect(out).toContain('id="user-content-introduction"');
    expect(out).toContain('id="user-content-strong-and-code"');
    expect(out).toContain('href="#introduction"');
  });

  test("title comes from frontmatter, then file name", async () => {
    expect((await renderMarkdown("---\ntitle: Trip Notes\n---\n# x", "/a/b.md")).title).toBe("Trip Notes");
    expect((await renderMarkdown("# x", "/a/trip.md")).title).toBe("trip");
    expect((await renderMarkdown("# x", null)).title).toBe("Untitled");
  });

  test("frontmatter is shown collapsed, not as a heading or rule", async () => {
    const out = await html("---\ntitle: A\ntags: [x]\n---\n\nBody");
    expect(out).toContain('<details class="frontmatter"');
    expect(out).not.toContain("<hr");
    expect(out).toContain("<p");
  });

  test("a leading byte order mark does not break frontmatter", async () => {
    expect(await html("\uFEFF---\ntitle: A\n---\nBody")).toContain("frontmatter");
  });

  test("block direction follows the first strong character", async () => {
    const out = await html("שלום עולם\n\nHello");
    expect(out.match(/<p dir="auto">/g)?.length).toBe(2);
  });
});

describe("extensions", () => {
  test("task lists render disabled checkboxes", async () => {
    const out = await html("- [x] done\n- [ ] todo\n");
    expect(out).toContain("task-list-item");
    expect(out.match(/type="checkbox"/g)?.length).toBe(2);
    expect(out).toContain("disabled");
  });

  test("GitHub alerts", async () => {
    const out = await html("> [!WARNING]\n> careful\n");
    expect(out).toContain("markdown-alert-warning");
  });

  test("footnotes", async () => {
    const out = await html("Text[^1]\n\n[^1]: Note\n");
    expect(out).toContain("footnote");
  });

  test("tables", async () => {
    expect(await html("| a | b |\n|---|---|\n| 1 | 2 |\n")).toContain("<table");
  });

  test("code fences get a copy button and a language label", async () => {
    const out = await html("```ts\nconst a: number = 1\n```\n");
    expect(out).toContain('class="code-block"');
    expect(out).toContain('data-lang="ts"');
    expect(out).toContain("copy-code");
    expect(out).toContain("shiki");
  });

  test("unknown languages fall back to plain code", async () => {
    const out = await html("```nonsense-lang\nx\n```\n");
    expect(out).toContain("<pre");
    expect(out).not.toContain("shiki");
  });

  test("mermaid fences are left for the diagram renderer", async () => {
    const out = await html("```mermaid\ngraph LR\nA-->B\n```\n");
    expect(out).toContain('<pre class="mermaid">');
    expect(out).not.toContain("copy-code");
  });

  test("inline and display math", async () => {
    const out = await html("Inline $E=mc^2$\n\n$$\n\\int_0^1 x\\,dx\n$$\n");
    expect(out).toContain("katex");
    expect(out).toContain("katex-display");
  });
});

describe("security", () => {
  test("raw HTML is carried as author content for DOM sanitization", async () => {
    const out = await renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>', "/tmp/note.md");
    expect(out.content).toBeDefined();
    expect(JSON.stringify(out.content)).toContain('"kind":"author"');
  });

  test("javascript: links are not linked", async () => {
    const out = await html("[x](javascript:alert(1))");
    expect(out).not.toContain("href=");
  });

  test("KaTeX cannot emit active links", async () => {
    const out = await html("$\\href{https://evil.example}{click}$");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href=");
  });

  test("code fence info strings are escaped in the label", async () => {
    const out = await html('```"><script>x\ncode\n```\n');
    expect(out).not.toContain("<script>");
  });
});

describe("images", () => {
  test("relative images resolve against the document folder", async () => {
    const out = await html("![a](pics/a%20b.png)", path.resolve(os.tmpdir(), "Notes/note.md"));
    expect(out).toContain(pathToFileURL(path.resolve(os.tmpdir(), "Notes/pics/a b.png")).href);
  });

  test("encoded reserved filename characters are not encoded twice", async () => {
    const out = await html("![a](pics/image%20%231%3F.png)", path.resolve(os.tmpdir(), "notes/doc.md"));
    expect(out).toContain(pathToFileURL(path.resolve(os.tmpdir(), "notes/pics/image #1?.png")).href);
    expect(out).not.toContain("%25");
  });

  test("remote images are untouched", async () => {
    const out = await html("![a](https://example.com/a.png)");
    expect(out).toContain("https://example.com/a.png");
  });

  test("unsaved documents leave relative paths alone", async () => {
    const out = await html("![a](a.png)", null);
    expect(out).toContain('src="a.png"');
  });
});

describe("mdx", () => {
  test("imports stay hidden and JSX renders as a component", async () => {
    const out = await html("import X from './x'\n\n<X />\n\n```js\nimport a from 'b'\n```", "/a.mdx");
    expect(out).not.toContain("import X");
    expect(out).toContain('class="mdx-component"');
    expect(out).toContain('class="mdx-label">X');
    expect(out).toContain("import");
  });

  test("only .mdx files are preprocessed", async () => {
    expect(await html("import X from 'x'\n\nhi", "/a.md")).toContain("import X");
    expect(await html("import X from 'x'\n\nhi", "/a.mdx")).not.toContain("import X");
  });
});

describe("fragments", () => {
  test("render a lone block", async () => {
    expect((await renderFragment("| a |\n|---|\n| 1 |", undefined)).html).toContain("<table");
  });
});


describe("block rendering cache", () => {
  test("duplicate headings retain their resolved suffixes across cache hits", async () => {
    const source = "# Cache heading\n\n# Cache heading\n\n# Cache heading";
    for (let i = 0; i < 2; i++) {
      const out = await renderBlocks(source, "/tmp/duplicate.md");
      expect(out.blocks.map((block) => block.html).join("")).toBe(await html(source, "/tmp/duplicate.md"));
      expect(new Set(out.blocks.map((block) => block.key)).size).toBe(out.blocks.length);
    }
  });

  test("inserting a duplicate updates a heading whose source did not change", async () => {
    const first = await renderBlocks("# Move heading", "/tmp/move.md");
    const next = await renderBlocks("# Move heading\n\n# Move heading", "/tmp/move.md");
    expect(next.blocks[1]!.html).toContain('id="user-content-move-heading-1"');
    expect(next.blocks[1]!.key).not.toBe(first.blocks[0]!.key);
  });

  test("reference destination edits invalidate resolved links and images", async () => {
    const source = "[linked][target]\n\n![image][picture]\n\n[target]: https://first.example\n[picture]: old.png";
    const doc = path.resolve(os.tmpdir(), "references.md");
    const first = await renderBlocks(source, doc);
    const second = await renderBlocks(source.replace("first.example", "next.example").replace("old.png", "new.png"), doc);
    expect(second.blocks[0]!.html).toContain("https://next.example");
    expect(second.blocks[1]!.html).toContain(pathToFileURL(path.resolve(os.tmpdir(), "new.png")).href);
    expect(second.blocks[0]!.key).not.toBe(first.blocks[0]!.key);
    expect(second.blocks[1]!.key).not.toBe(first.blocks[1]!.key);
  });

  test("footnote numbering and definitions follow the full document", async () => {
    const sources = [
      "First[^a]\n\nSecond[^b]\n\n[^a]: Alpha\n[^b]: Bravo",
      "Second[^b]\n\nFirst[^a]\n\n[^a]: Alpha edited\n[^b]: Bravo",
      "First[^a] repeated[^a]\n\nSecond[^b]\n\n[^a]: Alpha edited\n[^b]: Bravo",
    ];
    for (const source of sources) {
      const out = await renderBlocks(source, "/tmp/footnotes.md");
      expect(out.blocks.map((block) => block.html).join("")).toBe(await html(source, "/tmp/footnotes.md"));
    }
  });

  test("footnote sections stay balanced inside a single patchable block", async () => {
    const out = await renderBlocks("A[^a] and B[^b]\n\n[^a]: First\n[^b]: Second", "/tmp/balanced.md");
    const section = out.blocks.filter((block) => block.html.includes('<section class="footnotes">'));
    expect(section).toHaveLength(1);
    expect(section[0]!.html).toContain("</section>");
    expect(section[0]!.html).toContain("First");
    expect(section[0]!.html).toContain("Second");
  });

  test("editing one ordinary block preserves unrelated block keys", async () => {
    const first = await renderBlocks("# Keep\n\nBefore\n\nLast", "/tmp/stable.md");
    const next = await renderBlocks("# Keep\n\nAfter\n\nLast", "/tmp/stable.md");
    expect(next.blocks[0]!.key).toBe(first.blocks[0]!.key);
    expect(next.blocks[1]!.key).not.toBe(first.blocks[1]!.key);
    expect(next.blocks[2]!.key).toBe(first.blocks[2]!.key);
  });
});

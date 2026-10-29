import { describe, expect, test } from "bun:test";
import { createRenderCore } from "../src/shared/render-core";
import { editorMdxRanges } from "../src/renderer/mdx-positions";
import { findMdxRanges } from "../src/shared/mdx-ranges";
import type { RenderNode } from "../src/shared/render-tree";

const core = createRenderCore();
const render = (source: string) => core.renderBlocks(source, "/posts/note.mdx");
function authorNodes(node: RenderNode): RenderNode[] {
  return [...(node.kind === "author" ? [node] : []), ...node.parts.flatMap((part) => typeof part === "string" ? [] : authorNodes(part))];
}

describe("positioned MDX preview", () => {
  test("hides multiline ESM and comments, preserving ordinary Markdown and code fences", async () => {
    const source = 'import {\n A\n} from "x"\n\n# Heading\n\n{/* private */}\n\n```mdx\n<A />\n{value}\n```';
    const result = await render(source);
    const html = result.blocks.map((b) => b.html).join("");
    expect(html).not.toContain('from "x"');
    expect(html).not.toContain("private");
    expect(html).toContain("&lt;A /&gt;");
    expect(html).toContain("{value}");
    expect(result.blocks.find((b) => b.html.includes("<h1"))?.sourceRange).toEqual([4, 5]);
  });

  test("renders nested and inline components with Markdown children and escaped expression tokens", async () => {
    const result = await render('Text <Badge>**bold** {"<img onerror=run()>"}</Badge>.\n\n<Card title={run()}>\n\n## Child\n\n<Nested />\n\n</Card>');
    const html = result.blocks.map((b) => b.html).join("");
    expect(result.mdx?.error).toBeUndefined();
    expect(html).toContain('class="mdx-label">Badge');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('class="mdx-label">Nested');
    expect(html).toContain("Child</h2>");
    expect(html).toContain("&lt;img onerror=run()&gt;");
    expect(html).not.toContain("<img onerror");
    expect(html).not.toContain("run()</");
  });

  test("lowercase HTML uses author nodes with static attributes only and no className mapping", async () => {
    const result = await render('<details className="fake" open>\n\n<summary>Title</summary>\n\n**child** <a href="javascript:run()" onClick={run()}>link</a>\n\n</details>');
    const nodes = result.blocks.flatMap((block) => block.content ? authorNodes(block.content) : []);
    expect(nodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(nodes)).toContain('<details open=');
    expect(JSON.stringify(nodes)).not.toContain("className");
    expect(JSON.stringify(nodes)).not.toContain("onClick");
    expect(result.blocks.map((b) => b.html).join("")).toContain("<strong>child</strong>");
  });

  test("style and script bodies disappear, and attributes cannot spoof app markup", async () => {
    const result = await render('<style>{`body { display:none }`}</style>\n\n<script>{`globalThis.executed=true`}</script>\n\n<div className="mdx-component" data-owned="true">safe</div>');
    const html = result.blocks.map((b) => b.html).join("");
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("executed");
    expect(html).not.toContain('class="mdx-component"');
    expect(result.blocks.some((b) => b.content)).toBe(true);
  });

  test("incomplete MDX exposes an escaped failing range and recovers after closing", async () => {
    const source = '# Good\n\n<Card value={';
    const invalid = await render(source);
    expect(invalid.mdx?.error).toBeDefined();
    expect(invalid.blocks.at(-1)?.html).toContain("&lt;Card value={");
    expect(invalid.blocks.at(-1)?.html).toContain("Incomplete MDX");
    const good = await render(source + '1} />');
    expect(good.mdx?.error).toBeUndefined();
    expect(good.blocks.map((b) => b.html).join("")).toContain('class="mdx-label">Card');
  });

  test("maps BOM, CRLF, bare CR and astral source offsets to CodeMirror positions", () => {
    const source = '\uFEFF# 😀\r\n\r\n<A>\r\n**child**\r</A>';
    const ranges = findMdxRanges(source);
    const normalized = source.slice(1).replace(/\r\n|\r/g, "\n");
    const mapped = editorMdxRanges(source, { ranges });
    expect(normalized.slice(mapped[0]!.start, mapped[0]!.end)).toBe('<A>\n**child**\n</A>');
    expect(mapped[0]!.syntax.map((span) => normalized.slice(span.start, span.end))).toEqual(["A", "A"]);
  });
});

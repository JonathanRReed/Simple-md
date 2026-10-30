import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { urlContext, renderBlocks } from "../src/main/markdown";
import { containedLocalFile, invalidateUrlContext } from "../src/main/document-urls";
import { resolveAuthorUrl, resolveSrcset, parseSrcset } from "../src/shared/url-resolver";

const context = { baseUrl: "file:///project/docs/", rootUrl: "file:///project/" };
describe("shared author URL resolver", () => {
  test("validates schemes before and after resolution", () => {
    for (const value of ["javascript:alert(1)", "JaVaScRiPt:x", "java\tscript:x", "data:image/png;base64,AA", "file:///tmp/a.png", "\\\\host\\image", "vbscript:x"]) {
      expect(resolveAuthorUrl(value, "resource", context), value).toBeNull();
      expect(resolveAuthorUrl(value, "anchor", context), value).toBeNull();
    }
    expect(resolveAuthorUrl("mailto:x@example.test", "anchor")).toBe("mailto:x@example.test");
    expect(resolveAuthorUrl("mailto:x@example.test", "resource")).toBeNull();
    expect(resolveAuthorUrl("image.png", "resource", { baseUrl: "javascript:alert(1)" })).toBeNull();
    expect(resolveAuthorUrl("https://example.test/a", "resource", context, false)).toBeNull();
    expect(resolveAuthorUrl("https://example.test/a", "anchor", context, false)).toBe("https://example.test/a");
  });
  test("handles Markdown destinations, fragments and reserved filename characters", () => {
    expect(resolveAuthorUrl("../a%20%231.png?x=1#gh-dark-mode-only", "resource", context)).toBe("file:///project/a%20%231.png?x=1#gh-dark-mode-only");
    expect(resolveAuthorUrl("/images/a.png", "resource", context)).toBe("file:///project/images/a.png");
    expect(resolveAuthorUrl("#hello", "anchor", context)).toBe("#hello");
    expect(resolveAuthorUrl("/images/a.png", "resource")).toBeNull();
    expect(resolveAuthorUrl("//example.test/a", "resource")).toBe("https://example.test/a");
  });
  test("parses comma URLs and rejects malformed descriptors", () => {
    expect(parseSrcset("a,b.png 1x, c.png 2x")).toEqual([{ url: "a,b.png", descriptor: "1x" }, { url: "c.png", descriptor: "2x" }]);
    expect(resolveSrcset("data:image/png;base64,AA 1x, x.png 2x", context)).toBe("file:///project/docs/x.png 2x");
    expect(resolveSrcset("file:///tmp/a 1x, a.png 1x 2x", context)).toBeNull();
    expect(parseSrcset("a.png 1e2x, b.png .5x, c.png 000320w 200h, d.png 0x")).toEqual([
      { url: "a.png", descriptor: "1e2x" }, { url: "b.png", descriptor: ".5x" },
      { url: "c.png", descriptor: "000320w 200h" }, { url: "d.png", descriptor: "0x" },
    ]);
    expect(parseSrcset("a.png -1x, b.png 0w, c.png 1w 2x, d.png 1h, e.png 1X, f.png 1.x")).toEqual([]);
  });
  test("nearest project contains siblings; public only resolves root-relative paths", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "simplemd-url-"));
    try {
      const base = path.join(temp, "site/nested/docs");
      fs.mkdirSync(base, { recursive: true });
      fs.mkdirSync(path.join(temp, ".git"));
      fs.writeFileSync(path.join(temp, "site/nested/.git"), "gitdir: somewhere");
      const folder = (dir: string) => pathToFileURL(dir + path.sep).href;
      invalidateUrlContext(base);
      expect(urlContext(base).rootUrl).toBe(folder(path.join(temp, "site/nested")));
      fs.writeFileSync(path.join(temp, "site/astro.config.mjs"), "");
      invalidateUrlContext(base);
      expect(urlContext(base).rootUrl).toBe(folder(path.join(temp, "site/nested")));
      fs.mkdirSync(path.join(temp, "site/public"));
      invalidateUrlContext(base);
      expect(urlContext(base).rootUrl).toBe(folder(path.join(temp, "site/nested")));
      fs.rmSync(path.join(temp, "site/nested/.git"));
      invalidateUrlContext(base);
      const astro = urlContext(base);
      expect(astro.rootUrl).toBe(folder(path.join(temp, "site")));
      expect(astro.publicUrl).toBe(folder(path.join(temp, "site/public")));
      expect(resolveAuthorUrl("./prompts.mdx", "anchor", astro)).toBe(folder(base) + "prompts.mdx");
      expect(resolveAuthorUrl("./img.png", "resource", astro)).toBe(folder(base) + "img.png");
      expect(resolveAuthorUrl("/images/x", "resource", astro)).toBe(folder(path.join(temp, "site/public")) + "images/x");
      fs.rmSync(path.join(temp, "site/astro.config.mjs"));
      fs.rmSync(path.join(temp, ".git"), { recursive: true });
      invalidateUrlContext(base);
      expect(urlContext(base).rootUrl).toBeUndefined();
      expect(resolveAuthorUrl("/images/x", "resource", urlContext(base))).toBe(folder(path.join(temp, "site/public")) + "images/x");
      expect(resolveAuthorUrl("../../../../escape", "anchor", astro)).toBeNull();
      expect(resolveAuthorUrl("file:///etc/passwd", "anchor", astro)).toBeNull();
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  test("source ranges move without changing content keys, including frontmatter and MDX", async () => {
    const first = await renderBlocks("# A\n\nB\n", "/tmp/note.md");
    const next = await renderBlocks("\n# A\n\nB\n", "/tmp/note.md");
    expect(first.blocks.map((b) => b.sourceRange)).toEqual([[0, 1], [2, 3]]);
    expect(next.blocks.map((b) => b.sourceRange)).toEqual([[1, 2], [3, 4]]);
    expect(next.blocks.map((b) => b.key)).toEqual(first.blocks.map((b) => b.key));
    const mdx = await renderBlocks("---\ntitle: X\n---\n\nimport X from './x'\n\n# A\n\n<Thing />\n\nB", "/tmp/note.mdx");
    expect(mdx.blocks.map((b) => b.sourceRange)).toEqual([[0, 3], [6, 7], [8, 9], [10, 11]]);
  });
});

test("folder root lookup is reused until explicitly invalidated", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "smd-root-cache-"));
  try {
    const initial = urlContext(temp);
    fs.mkdirSync(path.join(temp, ".git"));
    expect(urlContext(temp)).toBe(initial);
    invalidateUrlContext(temp);
    expect(urlContext(temp).rootUrl).toBe(pathToFileURL(temp + path.sep).href);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Astro sibling links and images resolve through the real project containment check", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-astro-siblings-"));
  try {
    const base = path.join(dir, "src/content/blog");
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(path.join(dir, "public/images"), { recursive: true });
    fs.writeFileSync(path.join(dir, "astro.config.ts"), "");
    for (const file of ["src/content/blog/prompts.mdx", "src/content/blog/img.png", "public/images/x.png"]) fs.writeFileSync(path.join(dir, file), "fixture");
    const context = urlContext(base);
    for (const [source, expected, kind] of [["./prompts.mdx", "src/content/blog/prompts.mdx", "anchor"], ["./img.png", "src/content/blog/img.png", "resource"], ["/images/x.png", "public/images/x.png", "resource"]] as const) {
      const url = resolveAuthorUrl(source, kind, context)!;
      expect(await containedLocalFile(url, context)).toBe(fs.realpathSync(path.join(dir, expected)));
    }
    const rendered = await renderBlocks("[Sibling](./prompts.mdx)\n\n[Blocked](../../../../secret.md)", path.join(base, "post.mdx"));
    const html = rendered.blocks.map(block => block.html).join("");
    expect(html).toContain('href="' + pathToFileURL(path.join(base, "prompts.mdx")).href + '"');
    expect(html).toContain('title="Link blocked:');
    expect(html).not.toContain('href="../../../../secret.md"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

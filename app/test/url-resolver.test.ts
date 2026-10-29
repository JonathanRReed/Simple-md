import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { urlContext, renderBlocks } from "../src/main/markdown";
import { invalidateUrlContext } from "../src/main/document-urls";
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
  test("Astro ancestor wins over nearer git; otherwise nearest git, otherwise unresolved", () => {
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
      expect(urlContext(base).rootUrl).toBe(folder(path.join(temp, "site/public")));
      fs.rmSync(path.join(temp, "site/astro.config.mjs"));
      fs.rmSync(path.join(temp, "site/nested/.git"));
      fs.rmSync(path.join(temp, ".git"), { recursive: true });
      invalidateUrlContext(base);
      expect(urlContext(base).rootUrl).toBeUndefined();
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

import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { embedKatexFonts } from "../src/main/export-html";

test("KaTeX font URL replacements embed every format without nested url()", async () => {
  const css = '@font-face{src:url(fonts/Math.woff2) format("woff2"),url("fonts/Math.woff") format("woff"),url(\'fonts/Math.ttf\')}';
  const seen: string[] = [];
  const embedded = await embedKatexFonts(css, async (file) => { seen.push(file); return Buffer.from(file); });
  expect(seen.sort()).toEqual(["fonts/Math.ttf", "fonts/Math.woff", "fonts/Math.woff2"]);
  expect(embedded).not.toContain("url(fonts/");
  expect(embedded).not.toContain("url(url(");
  expect(embedded).toContain(`url(data:font/woff2;base64,${Buffer.from("fonts/Math.woff2").toString("base64")})`);
});

test("local images embed exact bytes and decode encoded filenames", async () => {
  const { embedLocalImages } = await import("../src/main/export-html");
  const { pathToFileURL } = await import("node:url");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-export-"));
  try {
    const filename = path.join(dir, "image #1.PNG");
    await fs.writeFile(filename, Buffer.from([1, 2, 3]));
    const remote = "https://example.com/image.png";
    const data = "data:image/png;base64,AQID";
    const embedded = await embedLocalImages([pathToFileURL(filename).href, remote, data], { baseUrl: pathToFileURL(dir + path.sep).href });
    expect(embedded).toEqual([data, remote, data]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("installed KaTeX CSS embeds all fonts with closed URL delimiters", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const file = path.resolve(import.meta.dir, "../node_modules/katex/dist/katex.min.css");
  const css = await fs.readFile(file, "utf8");
  const embedded = await embedKatexFonts(css, (relativePath) => fs.readFile(path.join(path.dirname(file), relativePath)));
  expect([...embedded.matchAll(/url\(data:font\/[a-z0-9]+;base64,[A-Za-z0-9+/=]+\)/g)].length).toBeGreaterThan(0);
  expect(embedded).not.toMatch(/url\(["']?fonts\//);
});

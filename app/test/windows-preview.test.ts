import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { renderStaticHtml } from "../src/shared/render-browser.js";
import { parse, defaultTreeAdapter as tree } from "parse5";
import { windowsRenderBundle } from "../build/windows-preview.mjs";

// No Electron, DOM runner, window, filesystem bridge or network in this context.
test("Windows bundle matches Quick Look static HTML on shared fixtures", async () => {
  let render: typeof renderStaticHtml | undefined;
  const context = { capture(value: typeof renderStaticHtml) { render = value; } };
  runInNewContext(`${await windowsRenderBundle()}\ncapture(SimpleMDRenderCore.renderStaticHtml);`, context, { timeout: 10_000 });
  if (!render) throw new Error("Missing static renderer");
  for (const file of ["perf/small.md", "perf/math.md", "perf/fences.md", "perf/diagrams.md", "mdx-editing.mdx", "bytes/bom-crlf.md"]) {
    const source = await readFile(new URL(`fixtures/${file}`, import.meta.url), "utf8");
    expect(await render(source, null)).toBe(await renderStaticHtml(source, null));
  }
  const source = `# Inert preview
<script>globalThis.pwned = true</script>
<img src="https://example.com/remote.png" onerror="alert(1)">
<img src="file:///neighbor.png">
<a href="javascript:alert(1)">unsafe link</a>

import Evil from './evil.js'

<Evil onClick={() => alert(1)} />

{globalThis.pwned = true}`;
  const html = await render(source, null);
  expect(html).toBe(await renderStaticHtml(source, null));
  expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
  const pending = [...parse(html).childNodes];
  while (pending.length) {
    const node = pending.pop()!;
    if (!tree.isElementNode(node)) continue;
    expect(node.tagName).not.toBe("script");
    for (const attr of node.attrs) {
      expect(attr.name).not.toMatch(/^on/i);
      if (["src", "href"].includes(attr.name)) expect(attr.value).not.toMatch(/^(?:javascript:|https?:|file:)/i);
    }
    pending.push(...node.childNodes);
  }
  expect(html).toContain("&lt;Evil onClick=");
  expect(await render("# bounded", null, { truncated: true, invalidUtf8: true }))
    .toBe(await renderStaticHtml("# bounded", null, { truncated: true, invalidUtf8: true }));
}, 60_000);

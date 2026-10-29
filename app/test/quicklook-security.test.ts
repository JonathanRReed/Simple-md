import { expect, test } from "bun:test";
import { renderStaticHtml } from "../src/shared/render-browser";
import { renderStaticTree, sanitizeAuthorHtmlStatic } from "../src/shared/sanitize-static";
import { embedStaticImages } from "../src/shared/static-images";
import { createRenderCore } from "../src/shared/render-core";
import { parseFragment, defaultTreeAdapter as tree } from "parse5";
import { runDom } from "./dom-runner";
import path from "node:path";

const urls = { baseUrl: "file:///project/", rootUrl: "file:///project/" };
test("preview removes local navigation from Markdown and every author link attribute", async () => {
  const source = '[docs](setup.command) [web](https://example.com) [mail](mailto:a@example.com) [section](#ok)\n\n<a href="setup.command">raw</a><img src="a.png" longdesc="setup.command"><q cite="setup.command">quote</q><div action="setup.command" usemap="setup.command">text</div>';
  const core = createRenderCore({ urls: () => urls });
  const rendered = await core.renderMarkdown(source, "/project/note.md");
  for (const html of [renderStaticTree(rendered, { urls }, true), await renderStaticHtml(source, "/project/note.md")]) {
    expect(html).not.toMatch(/(?:href|longdesc|cite|action|usemap)="file:/);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:a@example.com"');
    expect(html).toContain('href="#user-content-ok"');
  }
  expect(renderStaticTree(rendered, { urls })).toContain('href="file:///project/setup.command"');
});

test("duplicate IDs retain suffix collisions and finish within the preview deadline", async () => {
  const source = '<i id="x-1"></i>' + '<i id="x"></i>'.repeat(20_000);
  const start = performance.now();
  const output = sanitizeAuthorHtmlStatic(source);
  expect(performance.now() - start).toBeLessThan(1500);
  expect(output).toContain('id="user-content-x-20000"');
  const [result] = await runDom(path.join(import.meta.dir, "sanitizer/duplicate-browser.ts"), [source]) as { elapsed: number; ids: string[] }[];
  expect(result!.elapsed).toBeLessThan(1500);
  expect(result!.ids).toEqual([...output.matchAll(/id="([^"]+)"/g)].map(match => match[1]!));
}, 90_000);

test("deep author content is flattened at depth 512 without dropping text", () => {
  const output = sanitizeAuthorHtmlStatic('<div>'.repeat(6000) + 'keep &amp; safe' + '</div>'.repeat(6000));
  const root = parseFragment(output);
  const pending = root.childNodes.map(node => ({ node, depth: 1 }));
  let maximum = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (tree.isElementNode(node)) {
      maximum = Math.max(maximum, depth);
      for (const child of node.childNodes) pending.push({ node: child, depth: depth + 1 });
    }
  }
  expect(maximum).toBeLessThanOrEqual(512);
  expect(output).toContain('keep &amp; safe');
});

test("preview CSP and media cannot load local files", async () => {
  const html = await renderStaticHtml('<video src="movie.mp4"><source src="movie.mp4" srcset="movie.mp4 2x"></video>', "/project/note.md");
  expect(html).toContain("img-src data:;");
  expect(html).not.toMatch(/<(?:video|source)[^>]*\s(?:src|srcset)=/);
});

test("theme fragments survive replacement with embedded raster images", async () => {
  const html = await renderStaticHtml('![dark](dark.png#gh-dark-mode-only)\n\n![light](light.png#gh-light-mode-only)', "/project/note.md");
  const output = embedStaticImages(html, {
    'file:///project/dark.png#gh-dark-mode-only': 'data:image/png;base64,AAAA',
    'file:///project/light.png#gh-light-mode-only': 'data:image/png;base64,AAAA',
  });
  expect(output).toContain('data-simplemd-theme="dark"');
  expect(output).toContain('data-simplemd-theme="light"');
  expect(output).toContain('img[data-simplemd-theme="dark"]');
  const visibility = await runDom(path.join(import.meta.dir, 'sanitizer/theme-browser.ts'), [output]);
  expect(visibility).toEqual([[[false, true], [true, false]]]);
});

test("preview and thumbnail log interpolation keeps filenames private", async () => {
  for (const kind of ['preview/PreviewProvider', 'thumbnail/ThumbnailProvider']) {
    const source = await Bun.file(path.join(import.meta.dir, `../native/quicklook/${kind}.swift`)).text();
    expect(source).not.toMatch(/\\\(name, privacy: \.public\)/);
    expect(source).toContain('\\(name, privacy: .private)');
  }
});


test("static render exceptions return escaped plain-text source", async () => {
  const output = await renderStaticHtml('<script>run()</script> & source', 'file://[');
  expect(output).toContain('Preview unavailable. Showing source.');
  expect(output).toContain('&lt;script&gt;run()&lt;/script&gt; &amp; source');
  expect(output).not.toContain('<script>');
});

import { expect, test } from "bun:test";
import path from "node:path";
import { createRenderCore } from "../src/shared/render-core";
import { createMarkdownParser } from "../src/shared/markdown-parser";
import { sanitizeAuthorHtmlStatic, renderStaticTree } from "../src/shared/sanitize-static";
import { runDom } from "./dom-runner";
import { fixtures } from "./sanitizer/fixtures";
import { hostileInputs } from "./sanitizer/hostile";
import manifest from "./corpus/manifest.json";

const urls = { baseUrl: "file:///project/docs/", rootUrl: "file:///project/" };
const core = createRenderCore({ urls: () => urls });
const browser = path.join(import.meta.dir, "sanitizer/static-browser.ts");
interface Result { name: string; actual: string; expected: string; equal: boolean; hazards: string[] }
type Input = { name: string; source: string; staticHtml: string; remoteImages?: boolean };

test("static author policy matches every sanitizer fixture and all 41 corpus documents' raw HTML", async () => {
  const inputs = await Promise.all(fixtures.map(async (fixture) => {
    const options = { urls, remoteImages: "remoteImages" in fixture ? fixture.remoteImages : true };
    const rendered = "markdown" in fixture ? await core.renderMarkdown(fixture.source, "/project/docs/note.md") : undefined;
    return { ...fixture, rendered, staticHtml: rendered ? renderStaticTree(rendered, options) : sanitizeAuthorHtmlStatic(fixture.source, options) };
  }));
  const parser = createMarkdownParser();
  const corpus: Input[] = [];
  let fragments = 0;
  for (const entry of manifest) {
    const source = await Bun.file(path.join(import.meta.dir, `corpus/snapshots/${entry.id}.md`)).text();
    const tokens = parser.parse(source, {});
    const raw: string[] = [];
    const visit = (items: typeof tokens) => {
      for (const token of items) {
        if (token.type === "html_block" || token.type === "html_inline") { raw.push(token.content); fragments++; }
        if (token.children) visit(token.children);
      }
    };
    visit(tokens);
    // Test both individual fragments and the sequence, so split wrappers and
    // tree-construction interactions have coverage too. Empty documents count.
    for (const [index, html] of [...raw, raw.join("")].entries()) corpus.push({ name: `${entry.id}:${index}`, source: html, staticHtml: sanitizeAuthorHtmlStatic(html, { urls }) });
  }
  expect(manifest).toHaveLength(41);
  const results = await runDom(browser, [...inputs, ...corpus]) as Result[];
  expect(results.filter((result) => !result.equal)).toEqual([]);
  expect(results.filter((result) => result.hazards.length)).toEqual([]);
  console.log(`Static differential: ${fixtures.length} fixtures, ${manifest.length} corpus documents, ${fragments} raw fragments; zero differences`);
}, 60_000);


test("4,000 hostile inputs remain inert and match DOMPurify after browser reparse", async () => {
  const inputs = hostileInputs(4000).map((source, index) => ({ name: `seed-51a71c-${index}`, source, staticHtml: sanitizeAuthorHtmlStatic(source, { urls }) }));
  const results = await runDom(browser, inputs) as Result[];
  expect(results.filter((result) => result.hazards.length).slice(0, 20)).toEqual([]);
  expect(results.filter((result) => !result.equal).slice(0, 20)).toEqual([]);
}, 60_000);

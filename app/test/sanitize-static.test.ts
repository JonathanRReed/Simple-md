import { expect, test } from "bun:test";
import path from "node:path";
import { createRenderCore } from "../src/shared/render-core";
import { createMarkdownParser } from "../src/shared/markdown-parser";
import { sanitizeAuthorHtmlStatic, renderStaticTree } from "../src/shared/sanitize-static";
import { runDom } from "./dom-runner";
import { fixtures } from "./sanitizer/fixtures";
import { hostileInputs } from "./sanitizer/hostile";
import manifest from "./corpus/manifest.json";
import { parse, defaultTreeAdapter as tree, type DefaultTreeAdapterTypes as P } from "parse5";

const urls = { baseUrl: "file:///project/docs/", rootUrl: "file:///project/" };
const core = createRenderCore({ urls: () => urls });
const browser = path.join(import.meta.dir, "sanitizer/static-browser.ts");
interface Result { name: string; actual: string; expected: string; equal: boolean; parserEqual: boolean; serializable: boolean; hazards: string[] }
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
  function canonical(node: P.Node): unknown {
    if (tree.isTextNode(node)) return node.value;
    if (tree.isElementNode(node)) return [node.namespaceURI, node.tagName,
      node.attrs.map((a) => [(a.prefix ? a.prefix + ":" : "") + a.name, a.value]).sort(([a], [b]) => a!.localeCompare(b!)), node.childNodes.map(canonical)];
    if (tree.isCommentNode(node)) return [];
    if ("childNodes" in node) return node.childNodes.map(canonical);
    return [];
  }
  const inputs = hostileInputs(4000).map((source, index) => {
    const doc = parse(source, { scriptingEnabled: false });
    const html = doc.childNodes.find(tree.isElementNode)!;
    const body = html.childNodes.find((node) => tree.isElementNode(node) && node.tagName === "body")!;
    return { name: `seed-51a71c-${index}`, source, parsedDom: canonical(body), staticHtml: sanitizeAuthorHtmlStatic(source, { urls }) };
  });
  const results = await runDom(browser, inputs) as Result[];
  expect(results.filter((result) => result.hazards.length).slice(0, 20)).toEqual([]);
  const comparable = results.filter((result) => result.parserEqual && result.serializable);
  expect(comparable.length).toBeGreaterThan(2500);
  expect(comparable.filter((result) => !result.equal).slice(0, 20)).toEqual([]);
  console.log(`Static fuzz: ${results.length} safe pairs, ${comparable.length} comparable; ${results.filter((r) => !r.parserEqual).length} parser differences, ${results.filter((r) => r.parserEqual && !r.serializable).length} non-serializable DOMPurify trees`);
}, 60_000);

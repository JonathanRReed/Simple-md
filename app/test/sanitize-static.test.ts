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
import { authorTags, globalAttrs, perTag } from "../src/shared/sanitizer-policy";

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

test("policy attributes, inert document constructs and slot-name spoofing match the renderer", async () => {
  const attrs = [...new Set([...globalAttrs, ...Object.values(perTag).flat(), "class", "style", "onclick", "is", "data-evil", "aria-label"])];
  const sources = [
    ...authorTags.map((tag) => `<${tag} ${attrs.map((name) => `${name}="javascript:alert(1)"`).join(" ")}>Safe</${tag}>`),
    " \n\t<p>Whitespace</p>", "<html><head><title>Head</title><style>bad</style></head><body><p>Body</p></body></html>",
    "<template><p id=x>Hidden</p></template><p>Shown</p>", "<noscript><p>Hidden</p></noscript><p>Shown</p>",
    "<![CDATA[<b>Bad</b>]]><?xml test?><p>Shown</p><!--<p>Hidden</p>-->",
    '<p><!--<img>-->&lt;x&gt;</p><textarea>&lt;img onerror=alert(1)&gt;</textarea>',
    ...attrs.map((name) => `<p ${name}="javascript:alert(1)">Safe</p>`),
  ];
  const inputs = sources.map((source, i) => ({ name: `policy-${i}`, source, staticHtml: sanitizeAuthorHtmlStatic(source, { urls }) }));
  const rendered = await core.renderMarkdown('<details>\n<summary>More</summary>\n<simplemd-static-slot-0><img onerror=run() src=x></simplemd-static-slot-0>\n\n**Safe**\n\n</details>', "/project/docs/note.md");
  const results = await runDom(browser, [...inputs, { name: "slot spoof", source: "", rendered, staticHtml: renderStaticTree(rendered, { urls }) }]) as Result[];
  expect(results.filter((result) => !result.equal)).toEqual([]);
  expect(results.filter((result) => result.hazards.length)).toEqual([]);
  expect(sanitizeAuthorHtmlStatic("<frameset><frame src=javascript:run()></frameset>")).toBe("");
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

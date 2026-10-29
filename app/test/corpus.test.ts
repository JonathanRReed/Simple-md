import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { renderMarkdown } from "../src/main/markdown";
import documents from "./corpus/manifest.json";
import receipts from "./corpus/receipts.json";
import { categories, type Category, type Mismatch, type SemanticNode } from "./corpus/normalize";
import { extractArticle } from "./corpus/refresh";
import type { ComparisonInput } from "./corpus/browser";

const root = path.join(import.meta.dir, "corpus");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const strict = process.env.SIMPLEMD_CORPUS_GATE === "1";
interface Result { id: string; expected: SemanticNode; actual: SemanticNode; mismatches: Mismatch[] }

async function compareInDom(inputs: ComparisonInput[]): Promise<Result[]> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "simplemd-corpus-"));
  try {
    const bundle = path.join(temp, "browser.js");
    const built = await Bun.build({ entrypoints: [path.join(root, "browser.ts")], target: "browser", format: "iife", minify: false });
    if (!built.success || built.outputs.length !== 1) throw new Error(`Corpus browser bundle failed: ${built.logs.join("\n")}`);
    await Bun.write(bundle, built.outputs[0]!);
    const input = path.join(temp, "input.json");
    const output = path.join(temp, "output.json");
    await Bun.write(input, JSON.stringify(inputs));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    // Hosted Linux runners lack a configured SUID sandbox helper; the corpus DOM pass only loads local fixtures.
    const sandbox = process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [];
    const child = Bun.spawn([String(electron), ...sandbox, `--user-data-dir=${path.join(temp, "profile")}`, path.join(root, "dom-driver.cjs"), input, bundle, output], {
      env, stdout: "ignore", stderr: "pipe", signal: AbortSignal.timeout(60_000),
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Corpus DOM process exited ${code}: ${stderr}`);
    return await Bun.file(output).json();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const context = { repo: "owner/project", path: "docs/readme.md", commit: "a".repeat(40) };
const probe = (id: string, expected: string, actual: string): ComparisonInput => ({ id, expected, actual, context });

// These checks prevent a broad normalization from turning missing content into a pass.
const equivalent = [
  probe("chrome-and-heading", '<article class="markdown-body"><div class="markdown-heading"><h2>Hi</h2><a class="anchor" id="user-content-hi"><svg></svg></a></div></article>', '<h2 id="user-content-hi" dir="auto">Hi</h2>'),
  probe("table-alignment", '<markdown-accessiblity-table><table><tr><td align="right">a</td></tr></table></markdown-accessiblity-table>', '<table><tbody><tr><td style="text-align:right">a</td></tr></tbody></table>'),
  probe("camo-and-relative-images", '<img src="https://camo.githubusercontent.com/hash/a" data-canonical-src="https://example.com/a?x=1#image" alt="x">', '<img src="https://example.com/a?x=1#image" alt="x">'),
  probe("relative-image-path", `<img src="https://raw.githubusercontent.com/owner/project/${context.commit}/docs/a%20b.png?raw=true#gh-dark-mode-only">`, '<img src="file:///__corpus__/owner/project/docs/a%20b.png#gh-dark-mode-only">'),
  probe("code-highlighting", '<div class="highlight highlight-source-js"><pre><span>const</span> a = 1;\n</pre></div>', '<div class="code-block" data-lang="js"><button class="copy-code">Copy</button><pre class="shiki"><code>const a = 1;</code></pre></div>'),
  probe("footnote-ids", '<p>X<sup><a href="#user-content-fn-alpha-0123456789abcdef0123456789abcdef" id="user-content-fnref-alpha-0123456789abcdef0123456789abcdef" data-footnote-ref>1</a></sup></p><section class="footnotes"><ol><li id="user-content-fn-alpha-0123456789abcdef0123456789abcdef">Note <a href="#user-content-fnref-alpha-0123456789abcdef0123456789abcdef" data-footnote-backref>↩</a></li></ol></section>', '<p>X<sup class="footnote-ref"><a href="#footnote1">[1]</a><a class="footnote-anchor" id="footnote-ref1"></a></sup></p><hr class="footnotes-sep"><section class="footnotes"><ol><li id="footnote1">Note <a href="#footnote-ref1" class="footnote-backref">↩︎</a></li></ol></section>'),
  probe("mermaid-render", '<section data-type="mermaid"><pre lang="mermaid">graph LR\nA-->B\n</pre></section>', '<pre class="mermaid">graph LR\nA-->B\n</pre>'),
  probe("math-layout", '<math-renderer class="js-inline-math">$x+1$</math-renderer>', '<span class="katex"><math><semantics><annotation encoding="application/x-tex">x+1</annotation></semantics></math></span>'),
  probe("custom-emoji-exception", '<img class="emoji" alt=":octocat:" src="https://github.githubassets.com/octocat.png">', ':octocat:'),
  probe("geojson-exception", '<section data-type="geojson"><pre>{"type":"Point"}\n</pre></section>', '<pre><code class="language-geojson">{"type":"Point"}\n</code></pre>'),
  probe("topojson-exception", '<section data-type="topojson"><pre>{"type":"Topology"}\n</pre></section>', '<pre><code class="language-topojson">{"type":"Topology"}\n</code></pre>'),
  probe("stl-exception", '<section data-type="stl"><pre>solid x\nendsolid x\n</pre></section>', '<pre><code class="language-stl">solid x\nendsolid x\n</code></pre>'),
];
const different = [
  probe("missing-picture", '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"><img src="light.svg"></picture>', '<img src="light.svg">'),
  probe("missing-disclosure", '<details><summary>More</summary><p>text</p></details>', '<p>More text</p>'),
  probe("missing-math", '<math-renderer class="js-inline-math">$x$</math-renderer>', '<p>$x$</p>'),
  probe("unrendered-math", '<math-renderer class="js-inline-math">$x$</math-renderer>', '<span class="katex-error">x</span>'),
  probe("missing-mermaid", '<section data-type="mermaid"><pre lang="mermaid">graph LR\nA-->B\n</pre></section>', '<pre><code class="language-mermaid">graph LR\nA-->B</code></pre>'),
  probe("failed-mermaid", '<section data-type="mermaid"><pre lang="mermaid">invalid diagram</pre></section>', '<pre class="mermaid">invalid diagram</pre>'),
  probe("broken-heading-link", '<h2 id="user-content-hi">Hi</h2><a href="#hi">go</a>', '<h2 id="user-content-hi">Hi</h2><a href="#wrong">go</a>'),
  probe("code-spacing", '<pre><code>a  b\n</code></pre>', '<pre><code>a b\n</code></pre>'),
  probe("table-alignment-missing", '<table><tr><td align="right">a</td></tr></table>', '<table><tr><td>a</td></tr></table>'),
  probe("unicode-text", '<p>"plain"... :smile:</p>', '<p>“plain”… 😄</p>'),
  probe("theme-fragment", '<img src="logo.svg#gh-dark-mode-only">', '<img src="logo.svg">'),
  probe("reference-target", '<a href="next.md#keep">next</a>', '<a href="next.md#lost">next</a>'),
];

test("GitHub corpus reports semantic gaps without refreshing references", async () => {
  expect(documents).toHaveLength(41);
  expect(receipts).toHaveLength(documents.length);
  const inputs: ComparisonInput[] = [];
  const sources: string[] = [];
  for (const doc of documents) {
    const source = await Bun.file(path.join(root, "snapshots", `${doc.id}.md`)).text();
    sources.push(source);
    const reference = await Bun.file(path.join(root, "snapshots", `${doc.id}.html`)).text();
    const receipt = receipts.find((value) => value.id === doc.id);
    if (!receipt) throw new Error(`Missing receipt: ${doc.id}`);
    expect(hash(source)).toBe(receipt.sourceSha256);
    expect(hash(reference)).toBe(receipt.referenceSha256);
    expect(receipt?.rawUrl).toContain(`/${doc.commit}/${doc.path}`);
    expect(receipt?.pageUrl).toContain(`/blob/${doc.commit}/${doc.path}`);
    const rendered = await renderMarkdown(source, `/__corpus__/${doc.repo}/${doc.path}`);
    inputs.push({ id: doc.id, expected: reference, actual: rendered.html, rendered, context: doc });
  }
  const results = await compareInDom([...equivalent, ...different, ...inputs]);
  for (const input of equivalent) expect(results.find((result) => result.id === input.id)?.mismatches, input.id).toEqual([]);
  for (const input of different) expect(results.find((result) => result.id === input.id)?.mismatches.length, input.id).toBeGreaterThan(0);
  const corpus = results.filter((result) => inputs.some((input) => input.id === result.id));
  const flatten = (node: SemanticNode): SemanticNode[] => [node, ...node.children.flatMap(flatten)];
  const nodes = corpus.flatMap((result) => flatten(result.expected));
  const hasTag = (tag: string) => nodes.some((node) => node.tag === tag);
  for (const tag of ["picture", "source", "details", "summary", "table", "mermaid"]) expect(hasTag(tag), `live ${tag} coverage`).toBe(true);
  for (const mode of ["inline", "display"]) expect(nodes.some((node) => node.tag === "math" && node.attrs.mode === mode), `live ${mode} math`).toBe(true);
  for (const kind of ["note", "tip", "important", "warning", "caution", "footnotes"]) expect(nodes.some((node) => node.attrs.kind === kind), `live ${kind} coverage`).toBe(true);
  expect(nodes.some((node) => node.tag === "source" && node.attrs.media?.includes("prefers-color-scheme")), "theme-aware picture").toBe(true);
  expect(nodes.some((node) => node.tag === "img" && node.attrs.src?.includes("gh-dark-mode-only")), "theme image fragment").toBe(true);
  expect(nodes.some((node) => ["td", "th"].includes(node.tag) && node.attrs.align), "table alignment").toBe(true);
  expect(nodes.some((node) => node.tag === "li" && node.children.some((child) => ["ul", "ol"].includes(child.tag))), "nested lists").toBe(true);
  expect(nodes.some((node) => node.tag === "code-block" && (node.children[0]?.text?.length ?? 0) > 1000), "long code block").toBe(true);
  const visibleText = (node: SemanticNode) => flatten(node).map((child) => child.text ?? "").join("");
  expect(nodes.some((node) => /^h[1-6]$/.test(node.tag) && /[^\x00-\x7f]/.test(visibleText(node))), "Unicode heading").toBe(true);
  expect(corpus.some((result) => {
    const headings = flatten(result.expected).filter((node) => /^h[1-6]$/.test(node.tag)).map(visibleText);
    return new Set(headings).size < headings.length;
  }), "duplicate headings").toBe(true);
  expect(sources.some((source) => /!\[[^\]]*\]\[[^\]]+\]/.test(source)), "reference images").toBe(true);
  expect(sources.some((source) => /^\[[^\]]+\]:\s*https?:/m.test(source)), "reference links").toBe(true);
  expect(sources.some((source) => /^```math\s*$/m.test(source)), "math fence").toBe(true);
  expect(sources.some((source) => /:smile:|:white_check_mark:/.test(source)), "emoji shortcodes").toBe(true);
  const totals = Object.fromEntries(categories.map((category) => [category, 0]));
  const counts = (mismatches: Mismatch[]) => {
    const count: Partial<Record<Category, number>> = {};
    for (const mismatch of mismatches) count[mismatch.category] = (count[mismatch.category] ?? 0) + 1;
    return count;
  };
  for (const result of corpus) for (const mismatch of result.mismatches) totals[mismatch.category]!++;
  const total = corpus.reduce((sum, result) => sum + result.mismatches.length, 0);
  const reportDir = path.resolve(import.meta.dir, "../../.audit/corpus");
  await mkdir(reportDir, { recursive: true });
  const revision = await Bun.$`git rev-parse HEAD`.text();
  const report = ["# GitHub fidelity gaps", "", `Renderer revision: ${revision.trim()}. Working tree changes are not included in this identifier.`, "", `Documents: ${corpus.length}. Documents with gaps: ${corpus.filter((result) => result.mismatches.length).length}. Semantic edits: ${total}.`, "", "Counts are DOM edit operations, not feature pass rates. A missing subtree counts once. Inspect the JSON trees and mismatch paths before assigning work. GitHub math and diagram references prove source and server-side presence, not hydrated layout. SimpleMD Mermaid success uses the current DOM renderer. No network requests run during comparison.", "", "| Category | Edits |", "| --- | ---: |", ...categories.map((category) => `| ${category} | ${totals[category]} |`), "", "| Document | Edits | Categories |", "| --- | ---: | --- |", ...corpus.map((result) => `| ${result.id} | ${result.mismatches.length} | ${Object.entries(counts(result.mismatches)).map(([category, n]) => `${category}: ${n}`).join(", ") || "none"} |`)];
  await Bun.write(path.join(reportDir, "report.md"), report.join("\n") + "\n");
  await Bun.write(path.join(reportDir, "report.json"), JSON.stringify({ revision: revision.trim(), total, totals, documents: corpus }, null, 2) + "\n");
  console.log(`Corpus: ${corpus.length} documents, ${total} semantic edits. ${JSON.stringify(totals)}\nReport: ${reportDir}/report.md`);
  if (strict) expect(total, "Unexplained corpus mismatches; see .audit/corpus/report.md and report.json").toBe(0);
}, 90_000);

test("file-page extraction accepts article and embedded richText, rejects missing or truncated content", () => {
  const article = '<article class="markdown-body entry-content"><p>pinned</p></article>';
  expect(extractArticle(`<main>${article}</main>`)).toBe(article);
  expect(extractArticle(`<script type="application/json">${JSON.stringify({ richText: article })}</script>`)).toBe(article);
  expect(() => extractArticle('<html><h1>Sign in</h1></html>')).toThrow("found 0");
  expect(() => extractArticle(`{"richTextTruncated":true}${article}`)).toThrow("Truncated");
});

import { expect, test } from "bun:test";
import path from "node:path";
import { renderMarkdown } from "../src/main/markdown";
import { createRenderCore } from "../src/shared/render-core";
import { runDom } from "./dom-runner";
import { fixtures } from "./sanitizer/fixtures";

const core = createRenderCore({ urls: () => ({ baseUrl: "file:///project/docs/", rootUrl: "file:///project/public/" }) });
test("author HTML hostile fixtures produce the expected DOM", async () => {
  const inputs = await Promise.all(fixtures.map(async (fixture) => ({ ...fixture,
    ...('markdown' in fixture ? { rendered: await core.renderMarkdown(fixture.source, "/project/docs/note.md") } : {}) })));
  const results = await runDom(path.join(import.meta.dir, "sanitizer/browser.ts"), inputs) as { name: string; actual: string; expected: string; actualDom: unknown; expectedDom: unknown }[];
  expect(results.filter((r) => JSON.stringify(r.actualDom) !== JSON.stringify(r.expectedDom)).map(({ name, actual, expected }) => ({ name, actual, expected }))).toEqual([]);
}, 30_000);

test("reused generated IDs recover after an earlier duplicate is removed", async () => {
  const rendered = await core.renderMarkdown('<p id="same">Author</p>\n\n# Same\n\n[Jump](#same)', "/project/docs/note.md");
  const results = await runDom(path.join(import.meta.dir, "sanitizer/browser.ts"), [{ name: "reuse", source: "", rendered, removeFirstId: true,
    expected: '\n<h1 id="user-content-same" dir="auto">Same</h1>\n<p dir="auto"><a href="#user-content-same">Jump</a></p>\n' }]) as { actualDom: unknown; expectedDom: unknown; actual: string }[];
  expect(results[0]!.actualDom, results[0]!.actual).toEqual(results[0]!.expectedDom);
}, 30_000);

test("generated nodes retain their policies inside an author wrapper", async () => {
  const rendered = await renderMarkdown(`<details><summary>More</summary>

- [x] Task

> [!NOTE]
> Safe

Text[^a] and $x^2$.

[^a]: Footnote

~~~ts
const n = 1
~~~

~~~mermaid
graph LR
A-->B
~~~

<pre class="mermaid" data-evil="x" onclick="alert(1)">fake</pre>
</details>`, "/tmp/generated.md");
  const results = await runDom(path.join(import.meta.dir, "sanitizer/browser.ts"), [{ name: "generated", source: "", expected: "", rendered }]) as { generated: Record<string, number>; actual: string }[];
  expect(results[0]!.generated).toEqual({ shiki: 1, math: 1, checkbox: 1, alerts: 1, footnotes: 1, diagrams: 1, fake: 0 });
  expect(results[0]!.actual).toContain('<pre>fake</pre>');
}, 30_000);

import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { renderStaticHtml } from "../src/shared/render-browser";

const snippet = "```ts\nconst answer = 42;\n```";
const semicolon = '<span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span>';
const bundle = Bun.build({
  entrypoints: [path.resolve(import.meta.dir, "../src/shared/render-browser.ts")],
  target: "browser", format: "iife", minify: true, conditions: ["worker"],
  define: { "process.env.NODE_ENV": '"production"' },
}).then(async result => {
  if (!result.success || result.outputs.length !== 1) throw new Error("Static renderer build failed");
  return result.outputs[0]!.text();
});

async function sandbox() {
  const clock = { calls: 0, time: 0, pauseAt: Infinity, step: 0 };
  let render: typeof renderStaticHtml | undefined;
  runInNewContext(`${await bundle}\ncapture(SimpleMDRenderCore.renderStaticHtml);`, {
    Date: class extends Date {
      static now() {
        clock.calls++;
        clock.time += clock.calls === clock.pauseAt ? 1000 : clock.step;
        return clock.time;
      }
    },
    capture(value: typeof renderStaticHtml) { render = value; },
  }, { timeout: 10_000 });
  if (!render) throw new Error("Missing static renderer");
  return { render, clock };
}

test("both syntax themes finish despite a scheduling pause during tokenization", async () => {
  const { render, clock } = await sandbox();
  const expected = await render(snippet, null);
  expect(expected).toContain(semicolon);
  // Pause at every clock observation, including between the number and semicolon
  // in the light pass. No real sleep or host clock mutation is needed.
  const checkpoints = clock.calls;
  const results: { pauseAt: number; html: string }[] = [];
  for (let pauseAt = 1; pauseAt <= checkpoints; pauseAt++) {
    Object.assign(clock, { calls: 0, time: 0, pauseAt });
    results.push({ pauseAt, html: await render(snippet, null) });
  }
  for (const { pauseAt, html } of results) expect(html, `clock checkpoint ${pauseAt}`).toContain(semicolon);
  for (const { pauseAt, html } of results) expect(html, `clock checkpoint ${pauseAt}`).toBe(expected);
}, 30_000);

test("static fixtures match direct imports across repeated and reversed render orders", async () => {
  const { render, clock } = await sandbox();
  const files = ["perf/small.md", "perf/math.md", "perf/fences.md", "perf/diagrams.md", "mdx-editing.mdx", "bytes/bom-crlf.md"];
  const fixtures = await Promise.all(files.map(async file => ({
    file, source: await Bun.file(path.join(import.meta.dir, "fixtures", file)).text(),
  })));
  const expected = new Map<string, string>();
  for (const { file, source } of fixtures) expected.set(file, await renderStaticHtml(source, null));
  // Model a contended host deterministically instead of depending on cold regex
  // compilation taking longer than Shiki's default deadline on this machine.
  clock.step = 1000;
  for (const order of [fixtures, fixtures.toReversed(), fixtures]) {
    for (const { file, source } of order) {
      expect(await render(source, null), file).toBe(expected.get(file)!);
      expect(await renderStaticHtml(source, null), file).toBe(expected.get(file)!);
    }
    expect(await render(snippet, null)).toContain(semicolon);
  }
}, 60_000);

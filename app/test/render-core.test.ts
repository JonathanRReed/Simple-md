import { expect, test } from "bun:test";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import type { createRenderCore } from "../src/shared/render-core";

test("standalone browser core has no Node imports and renders without Node or a DOM", async () => {
  const result = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/shared/render-browser.ts")], target: "browser", conditions: ["worker"], format: "iife", minify: true });
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
  const bundle = await result.outputs[0]!.text();
  expect(bundle).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:|electron["'])/);
  const sandbox = vm.createContext({ SharedArrayBuffer: undefined, Atomics: undefined });
  vm.runInContext(bundle, sandbox, { timeout: 10_000 });
  const core = sandbox.SimpleMDRenderCore as ReturnType<typeof createRenderCore>;
  const fixture = '# Browser fixture\n\n**Safe**\n\n```ts\nconst answer: number = 42\n```\n\n$x^2$';
  const rendered = await core.renderMarkdown(fixture, null);
  expect(rendered.html).toContain('id="user-content-browser-fixture"');
  expect(rendered.html).toContain('class="shiki');
  expect(rendered.html).toContain('class="katex"');
  expect(rendered.html).toContain('<strong>Safe</strong>');
  const mdx = await core.renderMarkdown('# MDX &amp; text\n\n<Box>\n\n**child**\n\n</Box>', '/note.mdx');
  expect(mdx.html).toContain('class="mdx-component"');
  expect(mdx.html).toContain('<strong>child</strong>');
  for (const file of fs.readdirSync(path.resolve(import.meta.dir, "../src/shared"), { recursive: true, encoding: "utf8" }).filter(file => fs.statSync(path.resolve(import.meta.dir, "../src/shared", file)).isFile())) {
    expect(fs.readFileSync(path.resolve(import.meta.dir, "../src/shared", file), "utf8"), file).not.toMatch(/(?:from\s*|import\s*\()\s*["'](?:node:|electron["'])/);
  }
}, 30_000);

test("stdin MDX mode has no file location or cwd-relative image access", async () => {
  const { createWorkerRenderCore } = await import("../src/main/markdown");
  const core = createWorkerRenderCore();
  const out = await core.renderBlocks('<Widget />\n\n![local](./secret.png)', null, false, true);
  expect(out.mdx?.ranges.length).toBeGreaterThan(0);
  for (const block of out.blocks) {
    expect(block.urls?.baseUrl).toBeUndefined();
    expect(block.html).not.toContain("file:");
  }
  const main = fs.readFileSync(path.resolve(import.meta.dir, "../src/main/main.ts"), "utf8");
  expect(main).not.toContain("doc.path ?? doc.name");
  expect(/renderBlocks\([^\n]*file \?\? doc.name/.test(main)).toBe(false);
});

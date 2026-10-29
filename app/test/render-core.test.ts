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
  const sandbox = vm.createContext({});
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
  for (const file of fs.readdirSync(path.resolve(import.meta.dir, "../src/shared"))) {
    expect(fs.readFileSync(path.resolve(import.meta.dir, "../src/shared", file), "utf8"), file).not.toMatch(/(?:from\s*|import\s*\()\s*["'](?:node:|electron["'])/);
  }
}, 30_000);

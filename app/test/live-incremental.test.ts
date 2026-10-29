import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runDom } from "./dom-runner";

test("incremental decorations equal full recomputation after seeded edits and selections", async () => {
  const fixtures = ["small.md", "math.md", "fences.md", "astro.mdx"].map(name => fs.readFileSync(path.join(import.meta.dir, "fixtures/perf", name), "utf8"));
  fixtures.push('---\ntitle: Test\n---\n\n# Heading\n\n![image](./x.png)\n\n| A | B |\n|---|---|\n| x | y |\n\n- [ ] **Task**\n- item $x$\n\n$$\nx\n\ny\n$$\n\n~~~ts\nlet x = 1;\n~~~\n\n<Card>\n\n**MDX** $x$\n\n</Card>\n');
  fixtures.push(Array.from({ length: 60 }, (_, i) => `- Item ${i} **bold** $x$\n  - [ ] Nested ${i}\n`).join(""));
  const result = await runDom(path.join(import.meta.dir, "renderer/live-oracle.ts"), fixtures);
  expect(result).toEqual({ comparisons: fixtures.length * 450, failures: [] });
}, 60_000);

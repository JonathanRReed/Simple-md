import { expect, test } from "bun:test";
import path from "node:path";
import { renderBlocks } from "../src/main/markdown";
import { runDom } from "./dom-runner";

test("round 2 reading interactions preserve source, reveal Find matches and refresh HEAD", async () => {
  const text = '---\ntitle: Reading checks\nseoTitle: Hidden metadata\n---\n\n# Reading checks\n\n- [ ] Book laptop cart\n- [x] Done\n\nMath $x^2$.\n\n`inline`\n\n```js\nconst value = 42;\n```\n';
  const result = await runDom(path.join(import.meta.dir, "renderer/r2-reading.ts"), {
    text, rendered: await renderBlocks(text, "/tmp/checks.md"),
    toggled: await renderBlocks(text.replace("[ ] Book", "[x] Book"), "/tmp/checks.md"),
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  }, { screenshot: { path: "/tmp/simplemd-r2-reading.png", width: 1100, height: 760 } });
  expect(result).toEqual({ checkbox: true, undo: true, find: true, math: true, scoped: true, head: true, codeFont: true, commit: true, live: true });
}, 60000);

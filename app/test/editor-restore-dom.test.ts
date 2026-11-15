import { expect, test } from "bun:test";
import path from "node:path";
import { renderBlocks } from "../src/main/markdown";
import { runDom } from "./dom-runner";

test("Source entry preserves scrolling after the first editor measurement", async () => {
  const text = "# Title\n\n" + Array.from({ length: 160 }, (_, i) => `Paragraph ${i}.\n\n`).join("");
  expect(await runDom(path.join(import.meta.dir, "renderer/editor-restore.ts"), {
    text, rendered: await renderBlocks(text, "/tmp/restore.md"),
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  })).toEqual({ measured: true, scrolled: true });
}, 60_000);

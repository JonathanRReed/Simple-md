import { expect, test } from "bun:test";
import path from "node:path";
import { renderBlocks } from "../src/main/markdown";
import { runDom } from "./dom-runner";

test("source blocks retain position across modes, late layout and Back navigation", async () => {
  const text = Array.from({ length: 100 }, (_, i) => `## Part ${i}\n\n${`Paragraph ${i} with source text. `.repeat(18)}\n`).join("\n");
  const rendered = await renderBlocks(text, "/tmp/long.md");
  expect(await runDom(path.join(import.meta.dir, "renderer/scroll-sync-fixture.ts"), {
    text, rendered,
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  })).toEqual({ endSync: true, blockSync: true, layout: true, modeSwitch: true, back: true, export: true, conflict: true });
}, 60_000);

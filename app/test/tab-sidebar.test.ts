import { expect, test } from "bun:test";
import path from "node:path";
import { renderBlocks } from "../src/main/markdown";
import { runDom } from "./dom-runner";

test("sidebar navigation, resize, collapse and live placement preserve the open document", async () => {
  const text = "# Title\n\n" + Array.from({ length: 160 }, (_, i) => `Paragraph ${i}.\n\n`).join("");
  expect(await runDom(path.join(import.meta.dir, "renderer/tab-sidebar.ts"), {
    text, rendered: await renderBlocks(text, "/tmp/one/README.md"),
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  })).toEqual({ navigation: true, resize: true, placement: true, dirty: true, split: true, appearance: true });
}, 60_000);

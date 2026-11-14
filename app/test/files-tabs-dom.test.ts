import { expect, test } from "bun:test";
import path from "node:path";
import { runDom } from "./dom-runner";
import { renderBlocks } from "../src/main/markdown";
test("file and tab commands, moved editor state, history times and Settings actions stay connected", async () => {
  const text = Array.from({ length: 120 }, (_, i) => `Line ${i}\n`).join("\n");
  const rendered = await renderBlocks(text, "/tmp/one/file.md");
  expect(await runDom(path.join(import.meta.dir, "renderer/files-tabs.ts"), {
    text, rendered,
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  })).toEqual({ palette: true, movedState: true, historyTime: true, settingsActions: true });
}, 60_000);

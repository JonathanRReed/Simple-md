import { expect, test } from "bun:test";
import path from "node:path";
import { renderBlocks } from "../src/main/markdown";
import { runDom } from "./dom-runner";
test("active titles, duplicate tab names, middle truncation and split file names stay visible", async () => {
  expect(await runDom(path.join(import.meta.dir, "renderer/app-chrome.ts"), {
    rendered: await renderBlocks("# Title\n\nText\n", "/tmp/one/README.md"),
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  })).toEqual({ activeTitle: true, duplicateNames: true, middleTruncation: true, paneNames: true });
}, 60_000);

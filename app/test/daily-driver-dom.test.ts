import { expect, test } from "bun:test";
import path from "node:path";
import { runDom } from "./dom-runner";

test("daily-driver editor, picker, focus, layout and print regressions", async () => {
  expect(await runDom(path.join(import.meta.dir, "renderer/daily-driver.ts"), {
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  })).toEqual({ editor: true, picker: true, pane: true, layout: true, print: true });
}, 60_000);

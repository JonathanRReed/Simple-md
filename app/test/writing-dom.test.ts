import { expect, test } from "bun:test";
import path from "node:path";
import { runDom } from "./dom-runner";

test("writing counter, Read copy, pending images and Live folding", async () => {
  expect(await runDom(path.join(import.meta.dir, "renderer/writing.ts"), {
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  })).toEqual({ counter: true, folding: true, copy: true, images: true, panels: true });
}, 60_000);

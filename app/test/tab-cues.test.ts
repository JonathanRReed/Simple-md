import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runDom } from "./dom-runner";
test("selected tabs and active panes have shape cues", async () => {
  expect(await runDom(path.join(import.meta.dir, "renderer/tab-cues.ts"), fs.readFileSync(path.join(import.meta.dir, "../src/renderer/style.css"), "utf8"))).toEqual({ selectedShape: true, activeShape: true });
}, 60_000);

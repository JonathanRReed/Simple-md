import { expect, test } from "bun:test";
import path from "node:path";
import { runDom } from "./dom-runner";

test("compact chrome, pinned sections, readable labels, overflow and zen work in a hidden window", async () => {
  const inputs = {
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  };
  for (const media of [[], [{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }]]) {
    expect(await runDom(path.join(import.meta.dir, "renderer/tab-design.ts"), inputs, { media })).toEqual({ labels: true, overflow: true, pins: true, zen: true, themes: 8 });
  }
}, 60_000);

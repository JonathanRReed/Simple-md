import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runDom } from "./dom-runner";
import { renderBlocks } from "../src/main/markdown";

for (const variant of ["light", "dark", "forced-colors"]) test(`outline rail hidden DOM behavior and ${variant} screenshot`, async () => {
  const theme = variant === "dark" ? "dark" : "light";
  const text = Array.from({ length: 30 }, (_, i) => `${"#".repeat(i % 3 + 1)} ${i === 0 ? "Reading &lt;safely&gt; & writing" : `Chapter ${i + 1}`}\n\n${"A paragraph about reading and writing. ".repeat(24)}\n\n`).join("");
  const directory = process.env.SMD_OUTLINE_SCREENSHOTS ?? "/tmp/simplemd-outline-rail";
  await mkdir(directory, { recursive: true });
  expect(await runDom(path.join(import.meta.dir, "renderer/outline.ts"), {
    text, theme, rendered: await renderBlocks(text, "/tmp/outline.md"),
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  }, { media: [{ name: "prefers-reduced-motion", value: variant === "forced-colors" ? "no-preference" : "reduce" }, { name: "forced-colors", value: variant === "forced-colors" ? "active" : "none" }], screenshot: { path: path.join(directory, `outline-${variant}.png`), width: 1000, height: 760 } })).toEqual({ aria: true, hover: true, jump: true, keyboard: true, inView: true, scrub: true, split: true, live: true, source: true, disabled: true, fallback: true, deferred: true });
}, 60_000);

import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { renderBlocks } from "../src/main/markdown";
import { runDom } from "./dom-runner";

test("round-two chrome fixes work in hidden windows", async () => {
  const directory = "/tmp/simplemd-r2-chrome"; await mkdir(directory, { recursive: true });
  const text = "# PLAN\n\nKeep the document in focus.\n\n## Next\n\nReview incoming changes before saving.\n";
  const input = {
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
    text, rendered: await renderBlocks(text, "/tmp/PLAN.md"),
  };
  const task = "# Tasks\n\n- [ ] Review\n";
  expect(await runDom(path.join(import.meta.dir, "renderer/r2-chrome.ts"), { ...input, text: task, rendered: await renderBlocks(task, "/tmp/PLAN.md"), scene: "read-action" })).toEqual({ passed: true });
  for (const scene of ["tabs", "sidebar", "zen", "conflict"]) {
    expect(await runDom(path.join(import.meta.dir, "renderer/r2-chrome.ts"), { ...input, scene }, {
      screenshot: { path: path.join(directory, `${scene}.png`), width: 860, height: 600 },
    })).toEqual({ passed: true });
  }
}, 60_000);

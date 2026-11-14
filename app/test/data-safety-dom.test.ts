import { expect, test } from "bun:test";
import path from "node:path";
import { renderBlocks } from "../src/main/markdown";
import { runDom } from "./dom-runner";

for (const scenario of ["retained source", "metadata notice", "permissions", "missing recreate", "missing Save As", "Reload", "Keep mine"]) test(`file safety: ${scenario}`, async () => {
  const text = "\uFEFF# Original\r\nold line\nlast";
  const incoming = "\uFEFF# Incoming\r\nnew line\nend";
  expect(await runDom(path.join(import.meta.dir, "renderer/data-safety.ts"), {
    scenario, text, incoming,
    rendered: await renderBlocks(text, "/tmp/note.md"),
    updated: await renderBlocks(incoming, "/tmp/note.md"),
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
  })).toBe(true);
}, 60_000);

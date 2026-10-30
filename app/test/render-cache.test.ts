import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RenderCache, RENDER_CACHE_VERSION } from "../src/main/render-cache";
import { renderBlocks } from "../src/main/markdown";

const dirs: string[] = [];
const file = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-cache-test-"));
  dirs.push(dir);
  return path.join(dir, "render-cache.json");
};
const blocks = [{ key: "one", html: "<p>Current</p>", urls: {}, sourceRange: [0, 1] as [number, number] }];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("disk render cache", () => {
  test("preserves a balanced author wrapper and its source range on disk", async () => {
    const text = '<details>\n\n# Inside\n\n</details>';
    const rendered = await renderBlocks(text, "/note.md");
    expect(rendered.blocks).toHaveLength(1);
    expect(rendered.blocks[0]!.sourceRange).toEqual([0, 5]);
    expect(rendered.blocks[0]!.content?.kind).toBe("author");
    const target = file();
    const cache = new RenderCache(target);
    cache.set("/note.md", 1, text.length, rendered.title, rendered.blocks, text);
    cache.flush();
    expect(new RenderCache(target).get("/note.md", 1, text.length, text)).toEqual(rendered);
  });

  test("persists valid entries and checks source, mtime and size", () => {
    const target = file();
    const cache = new RenderCache(target);
    cache.set("/note.md", 1, 3, "Note", blocks, "old");
    cache.flush();
    const reopened = new RenderCache(target);
    expect(reopened.get("/note.md", 1, 3, "old")).toEqual({ title: "Note", blocks });
    expect(reopened.get("/note.md", 1, 3, "new")).toBeNull();
    expect(reopened.get("/note.md", 2, 3, "old")).toBeNull();
    expect(reopened.get("/note.md", 1, 4, "old")).toBeNull();
  });

  test("ignores legacy, stale, malformed and invalid block entries", () => {
    for (const data of [
      { "/note.md": { mtimeMs: 1, size: 3, title: "Old", blocks } },
      { version: RENDER_CACHE_VERSION - 1, entries: {} },
      { version: RENDER_CACHE_VERSION, entries: { "/note.md": { mtimeMs: 1, size: 3, title: "Bad", blocks: [null] } } },
      null,
    ]) {
      const target = file();
      fs.writeFileSync(target, JSON.stringify(data));
      expect(new RenderCache(target).get("/note.md", 1, 3, "old")).toBeNull();
    }
    const target = file();
    fs.writeFileSync(target, "{");
    expect(new RenderCache(target).get("/note.md", 1, 3, "old")).toBeNull();
  });

  test("caps serialized UTF8 bytes and refuses an oversized entry", () => {
    const target = file();
    const cache = new RenderCache(target, 1000);
    cache.set("/first.md", 1, 1, "Small", blocks, "a");
    cache.set("/huge.md", 1, 1, "Huge", [{ key: "huge", html: "界".repeat(1000), urls: {}, sourceRange: [0, 1] }], "b");
    cache.flush();
    expect(cache.get("/huge.md", 1, 1, "b")).toBeNull();
    expect(cache.get("/first.md", 1, 1, "a")).not.toBeNull();
    for (let i = 0; i < 10; i++) cache.set(`/unicode-${i}.md`, 1, 1, "Unicode", [{ key: "unicode", html: "界".repeat(80), urls: {}, sourceRange: [0, 1] }], "c");
    cache.flush();
    expect(fs.statSync(target).size).toBeLessThanOrEqual(1000);
    expect(cache.get("/unicode-9.md", 1, 1, "c")).not.toBeNull();
    expect(cache.get("/unicode-0.md", 1, 1, "c")).toBeNull();
  });

  test("retains the most recently read entries at the entry limit", () => {
    const target = file();
    const cache = new RenderCache(target);
    for (let i = 0; i < 24; i++) cache.set(`/note-${i}.md`, 1, 1, "Note", blocks, "a");
    expect(cache.get("/note-0.md", 1, 1, "a")).not.toBeNull();
    cache.set("/note-24.md", 1, 1, "Note", blocks, "a");
    expect(cache.get("/note-0.md", 1, 1, "a")).not.toBeNull();
    expect(cache.get("/note-1.md", 1, 1, "a")).toBeNull();
    cache.flush();
  });
});


test("upgrade discards cached lists without item ranges and persists current ranges", async () => {
  const text = "- One\n- Two\n";
  const rendered = await renderBlocks(text, "/list.md");
  const legacyBlocks = rendered.blocks.map(block => { const copy = { ...block }; delete copy.itemRanges; return copy; });
  const target = file();
  fs.writeFileSync(target, JSON.stringify({ version: 5, entries: { "/list.md": {
    ...rendered, blocks: legacyBlocks, mtimeMs: 1, size: text.length,
    sourceHash: createHash("sha256").update(text).digest("hex"),
  } } }));
  const cache = new RenderCache(target);
  expect(cache.get("/list.md", 1, text.length, text)).toBeNull();
  cache.set("/list.md", 1, text.length, rendered.title, rendered.blocks, text); cache.flush();
  expect(new RenderCache(target).get("/list.md", 1, text.length, text)?.blocks[0]?.itemRanges).toEqual([[0, 1], [1, 2]]);
});

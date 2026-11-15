import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenHistory, parseHistory } from "../src/main/open-history";
import { relativeTime } from "../src/shared/relative-time";
test("history validates, sorts, deduplicates and caps opened paths at 100", () => {
  const entries = Array.from({ length: 110 }, (_, i) => ({ path: path.resolve(`${i}.md`), lastOpened: i }));
  const parsed = parseHistory([null, { path: "relative.md", lastOpened: 1000 }, ...entries, entries[109], { path: path.resolve("bad.md"), lastOpened: -1 }]);
  expect(parsed).toHaveLength(100); expect(parsed[0]?.lastOpened).toBe(109); expect(parsed.at(-1)?.lastOpened).toBe(10);
});
test("history is lazy, stores times, filters missing files, follows moves and clears disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-history-")), store = path.join(dir, "history.json"), file = path.join(dir, "note.md"), target = path.join(dir, "moved.md");
  try {
    const history = new OpenHistory(store); fs.writeFileSync(file, "text"); history.opened(file, 2);
    expect(fs.existsSync(store)).toBe(false); history.flush();
    const restored = new OpenHistory(store); expect((await restored.searchFiles([])).map(({ path, lastOpened }) => ({ path, lastOpened }))).toEqual([{ path: file, lastOpened: 2 }]);
    fs.renameSync(file, target); restored.moved(file, target); restored.flush();
    expect((await new OpenHistory(store).searchFiles([])).map(({ path, lastOpened }) => ({ path, lastOpened }))).toEqual([{ path: target, lastOpened: 2 }]);
    fs.unlinkSync(target); expect((await restored.searchFiles([])).map(({ path, lastOpened }) => ({ path, lastOpened }))).toEqual([]); restored.clear(); expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual([]);
    restored.opened(file, 3); restored.clear(); expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("history result times are short and relative", () => {
  expect(relativeTime(0, 3 * 86400 * 1000)).toBe("3 days ago"); expect(relativeTime(0, 3600000)).toBe("1 hour ago"); expect(relativeTime(0, 61000)).toBe("1 minute ago"); expect(relativeTime(10000, 0)).toBe("just now");
});

test("legacy short recents remain searchable without inventing last-opened times", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-legacy-history-"));
  const history = new OpenHistory(path.join(dir, "history.json"));
  const known = path.join(dir, "known.md"), legacy = path.join(dir, "legacy.mdx");
  try {
    fs.writeFileSync(known, "known"); fs.writeFileSync(legacy, "legacy"); history.opened(known, 123);
    expect(await history.searchFiles([known, legacy, path.join(dir, "missing.md")])).toEqual([
      { path: known, lastOpened: 123, source: "recent" }, { path: legacy, source: "recent" },
    ]);
  } finally { history.clear(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unreachable history paths time out without blocking or removing them", async () => {
  const { availableHistoryFiles } = await import("../src/main/open-history");
  const calls: string[] = [];
  const files = ["/missing.md", "/share/slow.md", "/present.md"].map(path => ({ path, source: "recent" as const }));
  let ticked = false;
  setImmediate(() => { ticked = true; });
  const result = await availableHistoryFiles(files, async file => {
    calls.push(file);
    if (file.includes("slow")) return new Promise<boolean>(() => {});
    return !file.includes("missing");
  }, 10);
  expect(ticked).toBe(true);
  expect(result.map(file => file.path)).toEqual(["/share/slow.md", "/present.md"]);
  expect(calls).toHaveLength(3);
});

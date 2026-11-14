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
test("history is lazy, stores times, prunes missing files, follows moves and clears disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-history-")), store = path.join(dir, "history.json"), file = path.join(dir, "note.md"), target = path.join(dir, "moved.md");
  try {
    const history = new OpenHistory(store); fs.writeFileSync(file, "text"); history.opened(file, 2);
    expect(fs.existsSync(store)).toBe(false); history.flush();
    const restored = new OpenHistory(store); expect(restored.encountered()).toEqual([{ path: file, lastOpened: 2 }]);
    fs.renameSync(file, target); restored.moved(file, target); restored.flush();
    expect(new OpenHistory(store).encountered()).toEqual([{ path: target, lastOpened: 2 }]);
    fs.unlinkSync(target); expect(restored.encountered()).toEqual([]); restored.clear(); expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual([]);
    restored.opened(file, 3); restored.clear(); expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("history result times are short and relative", () => {
  expect(relativeTime(0, 3 * 86400 * 1000)).toBe("3 days ago"); expect(relativeTime(0, 3600000)).toBe("1 hour ago"); expect(relativeTime(0, 61000)).toBe("1 minute ago"); expect(relativeTime(10000, 0)).toBe("just now");
});

import { expect, test } from "bun:test";
import { isolatedRecents, recentFiles, jumpList, clearNativeRecents } from "../src/main/recents";

test("recents add, deduplicate, respect OS removals and clear", () => {
  const os = isolatedRecents();
  os.addRecentDocument("/a.md"); os.addRecentDocument("/b.md"); os.addRecentDocument("/a.md");
  expect(recentFiles(os, "darwin", [])).toEqual(["/a.md", "/b.md"]);
  os.getJumpListSettings = () => ({ removedItems: [{ type: "file", path: "/A.md" }] });
  os.addRecentDocument("/unrelated.pdf"); os.addRecentDocument("/foreign.md");
  const retained = recentFiles(os, "win32", ["/a.md", "/b.md", "/missing.md"]);
  expect(retained).toEqual(["/b.md"]);
  os.getJumpListSettings = () => ({ removedItems: [] });
  expect(recentFiles(os, "win32", retained)).toEqual(["/b.md"]);
  os.clearRecentDocuments();
  expect(recentFiles(os, "darwin", ["/stale.md"])).toEqual([]);
  expect(recentFiles(os, "linux", ["/local.md"])).toEqual(["/local.md"]);
});
test("Windows clears only its custom Recent category and keeps New Window", () => {
  expect(jumpList("C:\\SimpleMD.exe")).toEqual([
    { type: "tasks", items: [{ type: "task", title: "New Window", description: "Open a new SimpleMD window", path: "C:\\SimpleMD.exe", args: "--new-window", iconPath: "C:\\SimpleMD.exe", iconIndex: 0 }] },
  ]);
  const populated = jumpList("C:\\SimpleMD.exe", undefined, ["C:\\note.md"]);
  expect(populated[0]).toEqual({ name: "Recent", items: [{ type: "file", path: "C:\\note.md" }] });
  expect(populated.some(category => category.type === "recent")).toBe(false);
});

test("Clear Menu never invokes Windows global history clearing", () => {
  const os = isolatedRecents();
  let cleared = 0;
  os.clearRecentDocuments = () => { cleared++; };
  clearNativeRecents(os, "win32"); clearNativeRecents(os, "linux");
  expect(cleared).toBe(0);
  clearNativeRecents(os, "darwin");
  expect(cleared).toBe(1);
});

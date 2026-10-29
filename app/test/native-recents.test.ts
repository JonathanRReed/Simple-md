import { expect, test } from "bun:test";
import { isolatedRecents, recentFiles, jumpList } from "../src/main/recents";

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
test("Windows uses the OS recent category and a New Window task", () => {
  expect(jumpList("C:\\SimpleMD.exe")).toEqual([
    { type: "recent" }, { type: "tasks", items: [{ type: "task", title: "New Window", description: "Open a new SimpleMD window", path: "C:\\SimpleMD.exe", args: "--new-window", iconPath: "C:\\SimpleMD.exe", iconIndex: 0 }] },
  ]);
});

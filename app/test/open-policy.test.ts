import { expect, test } from "bun:test";
import { fileOpenIntent, opensInSource } from "../src/shared/open-policy";

test("ordinary opens read; editor jobs and line targets use Source", () => {
  for (const file of ["/notes/README.md", "C:\\notes\\note.mdx", "/notes/plain.txt"]) {
    expect(fileOpenIntent(file)).toBe("read");
    expect(opensInSource(file)).toBe(false);
    expect(fileOpenIntent(file, false, { kind: "heading", heading: "intro" })).toBe("read");
    expect(opensInSource(file, true)).toBe(true);
    expect(opensInSource(file, false, { kind: "line", line: 42 })).toBe(true);
  }
  for (const file of ["/repo/.git/COMMIT_EDITMSG", "/notes/AGENTS", "C:\\repo\\LICENSE"]) {
    expect(fileOpenIntent(file)).toBe("edit");
    expect(opensInSource(file)).toBe(true);
  }
});

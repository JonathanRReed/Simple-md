import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { matchesOpenPath } from "../src/main/open-path";

test("Finder opens a real file separately from its CLI draft", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smd-draft-open-")));
  const file = path.join(root, "note.md");
  try {
    const draft = { path: null, draftPath: file, text: "draft text" };
    expect(await matchesOpenPath(draft, file, file)).toBe(true);
    await fs.writeFile(file, "real file\r\n");
    expect(await matchesOpenPath(draft, file, file)).toBe(false);
    expect(draft.text).toBe("draft text");
    expect(await matchesOpenPath({ path: file }, file, file)).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

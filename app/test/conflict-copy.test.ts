import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeConflictCopy } from "../src/main/conflict-copy";

test("saving a conflict copy preserves incoming bytes and refuses the original or its symlink", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-conflict-copy-"));
  try {
    const original = path.join(dir, "note.md"), copy = path.join(dir, "note copy.md"), alias = path.join(dir, "alias.md");
    await fs.writeFile(original, "Incoming\r\n");
    const mine = "\uFEFFMy edits\r\nUntouched\rTail\n";
    await writeConflictCopy(original, copy, mine);
    expect(await fs.readFile(original, "utf8")).toBe("Incoming\r\n");
    expect(await fs.readFile(copy, "utf8")).toBe(mine);
    await expect(writeConflictCopy(original, original, mine)).rejects.toThrow("different file");
    await fs.symlink(original, alias);
    await expect(writeConflictCopy(original, alias, mine)).rejects.toThrow("different file");
    expect(await fs.readFile(original, "utf8")).toBe("Incoming\r\n");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

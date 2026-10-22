import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeAtomic } from "../src/main/files";

const dirs: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-files-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

test("concurrent writes use separate temporary files and leave one complete revision", async () => {
  const dir = await fixture();
  const file = path.join(dir, "note.md");
  const revisions = Array.from({ length: 16 }, (_, i) => `${i}\n${String(i).repeat(64_000)}`);
  await Promise.all(revisions.map((text) => writeAtomic(file, text)));
  expect(revisions).toContain(await fs.readFile(file, "utf8"));
  expect(await fs.readdir(dir)).toEqual(["note.md"]);
});

test("saving preserves existing private permissions", async () => {
  if (process.platform === "win32") return;
  const file = path.join(await fixture(), "private.md");
  await fs.writeFile(file, "old", { mode: 0o600 });
  await writeAtomic(file, "new");
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
});

test("saving through a symlink updates its target and preserves the link", async () => {
  if (process.platform === "win32") return;
  const dir = await fixture();
  const target = path.join(dir, "target.md");
  const link = path.join(dir, "link.md");
  await fs.writeFile(target, "old");
  await fs.symlink("target.md", link);
  await writeAtomic(link, "new");
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(target, "utf8")).toBe("new");
});

test("a conflicting disk revision is preserved and temporary files are removed", async () => {
  const dir = await fixture();
  const file = path.join(dir, "note.md");
  await fs.writeFile(file, "external edit");
  await expect(writeAtomic(file, "local edit", "original")).rejects.toThrow("changed on disk");
  expect(await fs.readFile(file, "utf8")).toBe("external edit");
  expect(await fs.readdir(dir)).toEqual(["note.md"]);
});

test("a deleted note is not silently recreated over a missing revision", async () => {
  const file = path.join(await fixture(), "note.md");
  await expect(writeAtomic(file, "local edit", "original")).rejects.toThrow("changed on disk");
  expect(await fs.exists(file)).toBe(false);
});

test("directory watching follows repeated atomic replacement", async () => {
  const { watchDocument } = await import("../src/main/files");
  const file = path.join(await fixture(), "note.md");
  await fs.writeFile(file, "original");
  const revisions: string[] = [];
  const watcher = watchDocument(file, () => { revisions.push(require("node:fs").readFileSync(file, "utf8")); }, 10);
  try {
    await Bun.sleep(100);
    for (const revision of ["first external edit", "second external edit"]) {
      await fs.writeFile(`${file}.swap`, revision);
      await fs.rename(`${file}.swap`, file);
      const deadline = Date.now() + 2000;
      while (!revisions.includes(revision) && Date.now() < deadline) await Bun.sleep(10);
      expect(revisions).toContain(revision);
    }
  } finally { watcher.close(); }
});

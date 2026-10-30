import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeDocument, readDiskText, writeAtomic } from "../src/main/files";

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

test.skipIf(process.platform !== "win32")("atomic save retries temporary Windows sharing errors", async () => {
  const dir = await fixture(), file = path.join(dir, "note.md");
  await fs.writeFile(file, "old");
  const rename = spyOn(fs, "rename");
  rename.mockRejectedValueOnce(Object.assign(new Error("Sharing violation"), { code: "EPERM" }));
  try {
    await writeAtomic(file, "new", "old");
    expect(await fs.readFile(file, "utf8")).toBe("new");
    expect(await fs.readdir(dir)).toEqual(["note.md"]);
  } finally { rename.mockRestore(); }
});

test.skipIf(process.platform !== "win32")("an external edit during a Windows rename retry is preserved", async () => {
  const dir = await fixture(), file = path.join(dir, "note.md");
  await fs.writeFile(file, "old");
  const rename = spyOn(fs, "rename").mockImplementationOnce(async () => {
    await fs.writeFile(file, "external edit");
    throw Object.assign(new Error("Sharing violation"), { code: "EPERM" });
  });
  try {
    await expect(writeAtomic(file, "new", "old")).rejects.toThrow("changed on disk");
    expect(await fs.readFile(file, "utf8")).toBe("external edit");
    expect(await fs.readdir(dir)).toEqual(["note.md"]);
  } finally { rename.mockRestore(); }
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

for (const name of ["invalid-utf8", "utf16le-bom", "utf16be-bom", "utf16le", "utf16be"]) {
  test(`${name} opens read-only and cannot be overwritten`, async () => {
    const bytes = await fs.readFile(path.join(import.meta.dir, "fixtures/bytes", `${name}.md`));
    const file = path.join(await fixture(), "note.md");
    await fs.writeFile(file, bytes);
    expect(decodeDocument(bytes).readOnlyReason).toBe("Not a UTF-8 text file. Read only.");
    await expect(readDiskText(file)).rejects.toThrow("Read only");
    await expect(writeAtomic(file, "replacement")).rejects.toThrow("Read only");
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(await fs.readdir(path.dirname(file))).toEqual(["note.md"]);
  });
}

test("an invalid external revision cannot be replaced by a save with an old UTF-8 baseline", async () => {
  const file = path.join(await fixture(), "note.md");
  const bytes = Buffer.from([0xff, 0xfe, 65, 0]);
  await fs.writeFile(file, bytes);
  await expect(writeAtomic(file, "local edit", "previous")).rejects.toThrow("Read only");
  expect(await fs.readFile(file)).toEqual(bytes);
});

test("atomic save keeps xattrs, Finder tags, permissions and ACLs across repeated saves", async () => {
  if (process.platform !== "darwin") return;
  const file = path.join(await fixture(), "metadata.md");
  const original = await fs.readFile(path.join(import.meta.dir, "fixtures/bytes/metadata.md"));
  await fs.writeFile(file, original, { mode: 0o640 });
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(args);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  const tag = '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>SimpleMD\n6</string></array></plist>';
  run("xattr", "-w", "com.simplemd.test", "preserved", file);
  run("xattr", "-w", "com.apple.metadata:_kMDItemUserTags", tag, file);
  run("chmod", "+a", "everyone allow read", file);
  const previousTime = new Date("2020-01-02T03:04:05.000Z");
  await fs.utimes(file, previousTime, previousTime);
  const attributes = run("xattr", "-lx", file);
  const acl = run("ls", "-le", file).split("\n").slice(1).join("\n");
  for (const text of [original.toString() + "first", "short", original.toString()]) {
    await writeAtomic(file, text);
    expect(await fs.readFile(file)).toEqual(Buffer.from(text));
    expect(run("xattr", "-lx", file)).toBe(attributes);
    expect(run("ls", "-le", file).split("\n").slice(1).join("\n")).toBe(acl);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(previousTime.getTime());
  }
});

test("saving replaces a hard link while its other names retain the previous bytes", async () => {
  const dir = await fixture();
  const file = path.join(dir, "note.md");
  const link = path.join(dir, "other.md");
  await fs.writeFile(file, "old");
  await fs.link(file, link);
  await writeAtomic(file, "new", "old");
  expect(await fs.readFile(file, "utf8")).toBe("new");
  expect(await fs.readFile(link, "utf8")).toBe("old");
});

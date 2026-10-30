import { expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkExportDestination, writeExportAtomic } from "../src/main/export-write";

test.skipIf(process.platform === "win32")("export preserves target permissions and creates files under umask", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-export-mode-"));
  try {
    const target = path.join(dir, "out.html");
    for (const mode of [0o640, 0o2640]) {
      await fs.writeFile(target, "Old"); await fs.chmod(target, mode);
      await writeExportAtomic(target, "New", true);
      expect((await fs.stat(target)).mode & 0o7777).toBe(mode);
    }
    await fs.unlink(target);
    await writeExportAtomic(target, "Created", false);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o666 & ~process.umask());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) test(`no-clobber export falls back to wx on ${code}`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-export-link-"));
  const link = spyOn(fs, "link").mockRejectedValue(Object.assign(new Error(code), { code }));
  try {
    const target = path.join(dir, "out.html");
    await writeExportAtomic(target, "First", false);
    await expect(writeExportAtomic(target, "Second", false)).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("First");
    expect(await fs.readdir(dir)).toEqual(["out.html"]);
  } finally { link.mockRestore(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("existing exports fail before rendering with --force guidance, and force replaces atomically", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-export-existing-"));
  try {
    const target = path.join(dir, "out.html");
    await fs.writeFile(target, "Original");
    let rendered = false;
    await expect((async () => {
      await checkExportDestination(target, false);
      rendered = true;
      await writeExportAtomic(target, "Replacement", false);
    })()).rejects.toThrow("Use --force");
    expect(rendered).toBe(false);
    expect(await fs.readFile(target, "utf8")).toBe("Original");
    await checkExportDestination(target, true);
    await writeExportAtomic(target, "Replacement", true);
    expect(await fs.readFile(target, "utf8")).toBe("Replacement");
    expect(await fs.readdir(dir)).toEqual(["out.html"]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a writer winning after preflight gets a clear no-clobber error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-export-race-"));
  const target = path.join(dir, "out.html");
  const originalLink = fs.link.bind(fs);
  const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
    await fs.writeFile(target, "Other writer");
    return originalLink(from, to);
  });
  try {
    await expect(writeExportAtomic(target, "Ours", false)).rejects.toThrow("Use --force");
    expect(await fs.readFile(target, "utf8")).toBe("Other writer");
    expect(await fs.readdir(dir)).toEqual(["out.html"]);
  } finally { link.mockRestore(); await fs.rm(dir, { recursive: true, force: true }); }
});

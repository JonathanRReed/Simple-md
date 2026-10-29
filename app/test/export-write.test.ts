import { expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeExportAtomic } from "../src/main/export-write";

test.skipIf(process.platform === "win32")("export preserves target permissions and creates files under umask", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-export-mode-"));
  try {
    const target = path.join(dir, "out.html");
    await fs.writeFile(target, "Old", { mode: 0o640 });
    await writeExportAtomic(target, "New", true);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
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

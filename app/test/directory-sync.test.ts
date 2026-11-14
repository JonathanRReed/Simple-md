import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomic } from "../src/main/files";
import { writeExportAtomic } from "../src/main/export-write";

for (const kind of ["document", "export replace", "export create"]) for (const fails of [false, true]) {
  test.skipIf(process.platform === "win32")(`${kind} syncs its published directory${fails ? " without failing on sync error" : ""}`, async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "smd-dirsync-"));
    const file = path.join(dir, "note.md");
    if (kind !== "export create") await fs.promises.writeFile(file, "before");
    const open = fs.promises.open.bind(fs.promises);
    let synced = 0;
    const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === dir) {
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          expect(await fs.promises.readFile(file, "utf8")).toBe("after");
          synced++;
          if (fails) throw new Error("directory sync refused");
          return sync();
        });
      }
      return handle;
    });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      if (kind === "document") await writeAtomic(file, "after", "before");
      else await writeExportAtomic(file, "after", kind === "export replace");
      expect(synced).toBe(1);
      expect(log.mock.calls.some(call => String(call[0]).includes("could not sync"))).toBe(fails);
      expect(await fs.promises.readdir(dir)).toEqual(["note.md"]);
    } finally { hook.mockRestore(); log.mockRestore(); await fs.promises.rm(dir, { recursive: true, force: true }); }
  });
}

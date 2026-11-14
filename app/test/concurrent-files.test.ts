import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDocument, writeAtomic } from "../src/main/files";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "smd-races-")); dirs.push(dir);
  const file = path.join(dir, "note.md"); await fs.promises.writeFile(file, "before");
  return file;
}
for (const replacement of [false, true]) test(`read retries a ${replacement ? "replacement" : "write"} during reading`, async () => {
  const file = await fixture();
  const open = fs.promises.open.bind(fs.promises);
  let injected = false;
  const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file && !injected) {
      const read = handle.read.bind(handle);
      spyOn(handle, "read").mockImplementationOnce(async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        injected = true;
        if (replacement) { await fs.promises.writeFile(`${file}.swap`, "complete replacement"); await fs.promises.rename(`${file}.swap`, file); }
        else await fs.promises.writeFile(file, "complete rewrite");
        return result;
      });
    }
    return handle;
  });
  try { expect((await readDocument(file)).text).toBe(replacement ? "complete replacement" : "complete rewrite"); }
  finally { hook.mockRestore(); }
});

test("continuous changes during reading are bounded and cannot authorize a save", async () => {
  const file = await fixture();
  const open = fs.promises.open.bind(fs.promises);
  let reads = 0;
  const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file) {
      const read = handle.read.bind(handle);
      spyOn(handle, "read").mockImplementationOnce(async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        await fs.promises.writeFile(file, `external ${++reads}`);
        return result;
      });
    }
    return handle;
  });
  try {
    await expect(writeAtomic(file, "local", "before")).rejects.toThrow("keeps changing");
    expect(reads).toBe(3);
    expect(await fs.promises.readFile(file, "utf8")).toBe("external 3");
    expect(await fs.promises.readdir(path.dirname(file))).toEqual(["note.md"]);
  } finally { hook.mockRestore(); }
});

test("the disk comparison follows symlink checks immediately before replacement", async () => {
  const file = await fixture();
  const lstat = fs.promises.lstat.bind(fs.promises);
  let checks = 0;
  const hook = spyOn(fs.promises, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    if (String(args[0]) === file && ++checks === 2) await fs.promises.writeFile(file, "agent edit");
    return stat;
  });
  try {
    await expect(writeAtomic(file, "local", "before")).rejects.toThrow("changed on disk");
    expect(await fs.promises.readFile(file, "utf8")).toBe("agent edit");
  } finally { hook.mockRestore(); }
});

import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DocumentRegistry } from "../src/main/document-registry";
import { makeRevisionId, type DiskChange } from "../src/shared/types";

const dirs: string[] = [], registries: DocumentRegistry[] = [];
let busy = false;
const realStat = fs.promises.stat.bind(fs.promises);
// While busy, the named file never matches the open handle, as when another program is still writing it.
const stat = spyOn(fs.promises, "stat").mockImplementation((async (...args: Parameters<typeof fs.promises.stat>) => {
  const result = await realStat(...args) as fs.Stats;
  if (busy) result.mtimeMs += 1;
  return result;
}) as typeof fs.promises.stat);
afterEach(async () => {
  busy = false;
  for (const registry of registries.splice(0)) registry.dispose();
  for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "smd-busy-")); dirs.push(dir);
  const file = path.join(dir, "note.md"); await fs.promises.writeFile(file, "before");
  const registry = new DocumentRegistry(); registries.push(registry);
  return { file, doc: registry.create(file, "before") };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await Bun.sleep(10); }
  expect(check()).toBe(true);
}

test("a file that is still being written is not reported missing, and its text arrives once it settles", async () => {
  const { file, doc } = await fixture(), incoming: DiskChange[] = [];
  await fs.promises.writeFile(file, "after");
  busy = true;
  doc.watch(change => incoming.push(change));
  await Bun.sleep(120);
  expect(stat).toHaveBeenCalled();
  expect(incoming).toEqual([]);
  expect(doc.unavailableReason).toBeUndefined();
  expect(doc.dirty).toBe(false);
  expect(doc.conflict).toBe(false);
  busy = false;
  await until(() => incoming.length > 0);
  expect(incoming).toEqual([{ kind: "text", text: "after", readOnlyReason: undefined }]);
});

test("saving while the file is still being written is a conflict that keeps both versions", async () => {
  const { file, doc } = await fixture();
  expect(doc.edit("mine", makeRevisionId(1))).toBe(true);
  busy = true;
  expect(await doc.save(file, doc.revisionId)).toBeNull();
  expect(doc.unavailableReason).toBeUndefined();
  expect(doc.conflict).toBe(true);
  expect(doc.text).toBe("mine");
  busy = false;
  expect(await fs.promises.readFile(file, "utf8")).toBe("before");
});

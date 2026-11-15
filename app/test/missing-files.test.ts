import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DocumentRegistry } from "../src/main/document-registry";
import { makeRevisionId, type DiskChange } from "../src/shared/types";

const dirs: string[] = [], registries: DocumentRegistry[] = [];
afterEach(async () => { for (const r of registries.splice(0)) r.dispose(); for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "smd-missing-")); dirs.push(dir);
  const file = path.join(dir, "note.md"); await fs.promises.writeFile(file, "before");
  const r = new DocumentRegistry(); registries.push(r);
  return { file, dir, doc: r.create(file, "before") };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(10); }
  expect(check()).toBe(true);
}
test("watcher reports deletion and retains even a previously clean buffer as dirty", async () => {
  const { file, doc } = await fixture(), incoming: DiskChange[] = [];
  doc.watch(change => incoming.push(change));
  await fs.promises.unlink(file);
  await until(() => incoming.some(change => change.kind === "unavailable"));
  expect(doc.unavailableReason).toContain("missing");
  expect(doc.dirty).toBe(true); expect(doc.text).toBe("before");
  expect(await doc.save(file, doc.revisionId)).toBeNull();
  expect(fs.existsSync(file)).toBe(false);
  expect(await doc.save(file, doc.revisionId, false, true)).not.toBeNull();
  expect(await fs.promises.readFile(file, "utf8")).toBe("before");
  expect(doc.unavailableReason).toBeUndefined(); expect(doc.dirty).toBe(false);
});
for (const saveAs of [false, true]) test(`save discovers deletion and permits explicit ${saveAs ? "Save As" : "recreation"}`, async () => {
  const { file, dir, doc } = await fixture(), changes: DiskChange[] = [];
  doc.watch(change => changes.push(change));
  doc.stopWatching();
  doc.edit("\uFEFFmine\r\nlast", makeRevisionId(1));
  await fs.promises.unlink(file);
  expect(await doc.save(file, doc.revisionId)).toBeNull();
  expect(changes.some(change => change.kind === "unavailable")).toBe(true);
  expect(doc.text).toBe("\uFEFFmine\r\nlast"); expect(doc.dirty).toBe(true);
  const target = saveAs ? path.join(dir, "other.md") : file;
  expect(await doc.save(target, doc.revisionId, saveAs, !saveAs)).not.toBeNull();
  expect(await fs.promises.readFile(target)).toEqual(Buffer.from("\uFEFFmine\r\nlast"));
});
test("recreation refuses to replace a file that reappeared", async () => {
  const { file, doc } = await fixture();
  doc.edit("mine", makeRevisionId(1)); await fs.promises.unlink(file);
  expect(await doc.save(file, doc.revisionId)).toBeNull();
  expect(doc.unavailableReason).toContain("missing");
  await fs.promises.writeFile(file, "other writer");
  expect(await doc.save(file, doc.revisionId, false, true)).toBeNull();
  expect(await fs.promises.readFile(file, "utf8")).toBe("other writer"); expect(doc.dirty).toBe(true);
});
test("unreadable files notify the renderer without replacing their buffers", async () => {
  const { file, doc } = await fixture(), changes: DiskChange[] = [];
  doc.watch(change => changes.push(change)); doc.stopWatching();
  doc.edit("mine", makeRevisionId(1));
  const open = fs.promises.open.bind(fs.promises);
  const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === file) throw Object.assign(new Error("unavailable"), { code: "EACCES" });
    return open(...args);
  });
  try {
    expect(await doc.save(file, doc.revisionId)).toBeNull();
    expect(changes).toContainEqual({ kind: "unavailable", message: "This file could not be read." });
    expect(doc.dirty).toBe(true); expect(doc.text).toBe("mine");
  } finally { hook.mockRestore(); }
});

test("disappearance reported while a save finishes cannot mark the buffer clean", async () => {
  if (process.platform === "win32") return;
  const { file, dir, doc } = await fixture(), changes: DiskChange[] = [];
  doc.watch(change => changes.push(change));
  doc.edit("mine", makeRevisionId(1));
  const open = fs.promises.open.bind(fs.promises);
  const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === dir) spyOn(handle, "sync").mockImplementationOnce(async () => {
      await fs.promises.unlink(file);
      await until(() => changes.some(change => change.kind === "unavailable"));
    });
    return handle;
  });
  try {
    const result = await doc.save(file, doc.revisionId);
    expect(result?.unavailableReason).toContain("missing");
    expect(doc.dirty).toBe(true); expect(doc.conflict).toBe(true); expect(doc.text).toBe("mine");
  } finally { hook.mockRestore(); }
});

test("a read that began while the file was missing cannot undo a successful recreation", async () => {
  if (process.platform === "win32") return;
  const { file, doc } = await fixture(), incoming: DiskChange[] = [];
  doc.watch(change => incoming.push(change));
  await fs.promises.unlink(file);
  await until(() => incoming.some(change => change.kind === "unavailable"));
  // Hold the next watcher read, then fail it as a read that started before the file came back.
  let release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const open = fs.promises.open.bind(fs.promises);
  const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === file && args[1] !== "wx" && !held && fs.existsSync(file)) {
      held = true;
      await gate;
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    }
    return open(...args);
  });
  try {
    expect(await doc.save(file, doc.revisionId, false, true)).not.toBeNull();
    await until(() => held);
    const reports = incoming.filter(change => change.kind === "unavailable").length;
    release();
    await Bun.sleep(300);
    expect(incoming.filter(change => change.kind === "unavailable")).toHaveLength(reports);
    expect(doc.unavailableReason).toBeUndefined();
    expect(doc.dirty).toBe(false);
    expect(await fs.promises.readFile(file, "utf8")).toBe("before");
  } finally { hook.mockRestore(); }
});

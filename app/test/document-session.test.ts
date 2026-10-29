import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocumentRegistry } from "../src/main/document-registry";
import { ENCODING_NOTICE, readDocument } from "../src/main/files";
import { makeRevisionId } from "../src/shared/types";

const registries: DocumentRegistry[] = [];
const dirs: string[] = [];
function registry() { const value = new DocumentRegistry(); registries.push(value); return value; }
afterEach(async () => {
  for (const value of registries.splice(0)) value.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-sessions-")); dirs.push(dir); return dir; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("registry retains independent sessions and never reuses a removed identity", () => {
  const docs = registry();
  const a = docs.create(null, "A"), b = docs.create(null, "B");
  expect(docs.get(a.documentId)).toBe(a);
  expect(docs.get(b.documentId)).toBe(b);
  docs.remove(a.documentId);
  expect(docs.get(a.documentId)).toBeUndefined();
  expect(docs.get(b.documentId)).toBe(b);
  expect(docs.create(null, "C").documentId).not.toBe(a.documentId);
});

test("an old render reply after a newer edit cannot replace the current preview", async () => {
  const doc = registry().create(null, "old");
  const oldRevision = doc.revisionId, late = deferred<string>();
  let preview = "initial";
  const old = doc.render(oldRevision, () => late.promise).then((value) => { preview = value; });
  const outcome = old.catch((error: unknown) => error);
  expect(doc.edit("new", makeRevisionId(1))).toBe(true);
  preview = await doc.render(doc.revisionId, async () => "new preview");
  late.resolve("old preview");
  expect(await outcome).toBeInstanceOf(Error);
  expect(preview).toBe("new preview");
  expect(doc.edit("old", oldRevision)).toBe(false);
  expect(doc.edit("different text", doc.revisionId)).toBe(false);
  expect(doc.text).toBe("new");
});

test("removing a session rejects its pending render without affecting another session", async () => {
  const docs = registry(), a = docs.create(null, "A"), b = docs.create(null, "B");
  const late = deferred<string>();
  const rendering = a.render(a.revisionId, () => late.promise);
  const outcome = rendering.catch((error: unknown) => error);
  docs.remove(a.documentId);
  late.resolve("A");
  expect(await outcome).toBeInstanceOf(Error);
  expect(await b.render(b.revisionId, async () => "B")).toBe("B");
});

test("two sessions save independent exact bytes and disk revisions at once", async () => {
  const dir = await directory();
  const aPath = path.join(dir, "a.md"), bPath = path.join(dir, "b.md");
  const aSource = "\uFEFF# A\r\nfirst\rsecond\nlast", bSource = "# B\r\nother\r\n";
  await Promise.all([fs.writeFile(aPath, aSource), fs.writeFile(bPath, bSource)]);
  const docs = registry();
  const a = docs.create(aPath, (await readDocument(aPath)).text), b = docs.create(bPath, (await readDocument(bPath)).text);
  a.edit(aSource + "!", makeRevisionId(1));
  a.edit(aSource + "!!", makeRevisionId(2));
  b.edit(bSource + "B", makeRevisionId(1));
  const results = await Promise.all([a.save(aPath, a.revisionId), b.save(bPath, b.revisionId)]);
  expect(results.every(Boolean)).toBe(true);
  expect(await fs.readFile(aPath)).toEqual(Buffer.from(aSource + "!!"));
  expect(await fs.readFile(bPath)).toEqual(Buffer.from(bSource + "B"));
  expect(a.diskText).toBe(aSource + "!!");
  expect(b.diskText).toBe(bSource + "B");
  expect(a.revisionId).toBe(2);
  expect(b.revisionId).toBe(1);
  expect(a.lineEndings).toEqual({ lf: 1, crlf: 1, cr: 1, bom: true, dominant: "\n" });
});

test("a queued stale save cannot write after a newer edit", async () => {
  const dir = await directory(), file = path.join(dir, "note.md");
  await fs.writeFile(file, "disk");
  const doc = registry().create(file, "disk");
  doc.edit("old", makeRevisionId(1));
  const gate = deferred<void>();
  const blocker = doc.saves.run(() => gate.promise);
  const old = doc.save(file, doc.revisionId);
  doc.edit("new", makeRevisionId(2));
  const latest = doc.save(file, doc.revisionId);
  gate.resolve();
  await blocker;
  expect(await old).toBeNull();
  expect(await latest).not.toBeNull();
  expect(await fs.readFile(file, "utf8")).toBe("new");
});

test("a disk conflict or read-only reason in one session does not block another save", async () => {
  const dir = await directory();
  const aPath = path.join(dir, "a.md"), bPath = path.join(dir, "b.md");
  await Promise.all([fs.writeFile(aPath, "A"), fs.writeFile(bPath, "B")]);
  const docs = registry(), a = docs.create(aPath, "A"), b = docs.create(bPath, "B");
  a.edit("mine", makeRevisionId(1)); b.edit("saved B", makeRevisionId(1));
  await fs.writeFile(aPath, "external A");
  expect(await a.save(aPath, a.revisionId)).toBeNull();
  expect(a.conflict).toBe(true);
  expect(await b.save(bPath, b.revisionId)).not.toBeNull();
  expect(b.conflict).toBe(false);
  expect(await fs.readFile(aPath, "utf8")).toBe("external A");
  expect(await fs.readFile(bPath, "utf8")).toBe("saved B");
  const locked = docs.create(aPath, "external A", "edit", ENCODING_NOTICE);
  expect(locked.encoding).toBe("unsupported");
  expect(await locked.save(path.join(dir, "copy.md"), locked.revisionId, true)).toBeNull();
});

test("clean accepted rewrites retain the first unseen baseline until Mark Seen", async () => {
  const dir = await directory(), file = path.join(dir, "watch.md");
  await fs.writeFile(file, "First");
  const doc = registry().create(file, "First");
  await fs.writeFile(file, "Second");
  expect(await doc.acceptDisk("Second", true)).toBe(true);
  expect(doc.baseline).toEqual({ kind: "watch", text: "First" });
  doc.edit("Second", makeRevisionId(1));
  await fs.writeFile(file, "Third");
  expect(await doc.acceptDisk("Third", true)).toBe(true);
  expect(doc.baseline?.text).toBe("First");
  doc.edit("Third", makeRevisionId(2));
  doc.markSeen();
  expect(doc.baseline).toBeNull();
  await fs.writeFile(file, "Fourth");
  expect(await doc.acceptDisk("Fourth", true)).toBe(true);
  expect(doc.baseline?.text).toBe("Third");
  doc.dispose();
  expect(doc.baseline).toBeNull();
});

test("dirty and explicit conflict reloads do not start watch highlights", async () => {
  const dir = await directory(), file = path.join(dir, "conflict.md");
  await fs.writeFile(file, "Before");
  const doc = registry().create(file, "Before");
  doc.edit("Mine", makeRevisionId(1));
  await fs.writeFile(file, "Theirs");
  expect(await doc.acceptDisk("Theirs", true)).toBe(true);
  expect(doc.baseline).toBeNull();
  doc.setHeadBaseline("Committed");
  expect(doc.baseline).toEqual({ kind: "head", text: "Committed" });
  doc.markSeen();
  expect(doc.baseline).toBeNull();
});

test("Save As clears the baseline associated with the previous file", async () => {
  const dir = await directory(), file = path.join(dir, "old.md");
  await fs.writeFile(file, "Current");
  const doc = registry().create(file, "Current");
  doc.setHeadBaseline("Committed");
  doc.gitStatusChecked = true;
  expect(await doc.save(path.join(dir, "new.md"), doc.revisionId)).not.toBeNull();
  expect(doc.baseline).toBeNull();
  expect(doc.gitStatusChecked).toBe(false);
});

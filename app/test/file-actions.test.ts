import { isolatedRecents, moveRecentDocument } from "../src/main/recents";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { destinationState, duplicateSuggestion, duplicateDocumentFile, hasRelativeResources, moveDocumentFile, relativeGitPath, saveSuggestion } from "../src/main/file-actions";
import { renameNoReplace } from "../src/main/file-metadata";
import { DocumentRegistry } from "../src/main/document-registry";
import { DocumentWaiters } from "../src/main/cli-protocol";
import { makeRevisionId } from "../src/shared/types";
import { execFileSync } from "node:child_process";
const dirs: string[] = [];
const registries: DocumentRegistry[] = [];
afterEach(async () => { for (const registry of registries.splice(0)) registry.dispose(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-actions-")); dirs.push(dir); return dir; }
const exact = "\uFEFF# Heading\r\nA\rB\nlast";
const crossVolume = (source: string, target: string, overrides: Partial<{ copy: (a: string, b: string) => Promise<void>; remove: (file: string) => Promise<void> }> = {}) => ({
  rename: async (a: string, b: string) => { if (a === source && b === target) throw Object.assign(new Error("different volume"), { code: "EXDEV" }); await renameNoReplace(a, b); },
  copy: async (a: string, b: string) => { await fs.copyFile(a, b, 1); }, remove: fs.unlink, ...overrides,
});
test("save and duplicate suggestions preserve draft extensions and document folders", () => {
  expect(saveSuggestion("draft.mdx", "/work")).toBe(path.join("/work", "draft.mdx"));
  expect(saveSuggestion("Untitled", "/work")).toBe(path.join("/work", "Untitled.md"));
  expect(duplicateSuggestion("/work/note.markdown")).toBe(path.join("/work", "note copy.markdown"));
  expect(duplicateSuggestion("/work/COMMIT_EDITMSG")).toBe(path.join("/work", "COMMIT_EDITMSG copy"));
});
test("relative resources produce one conservative move notice without rewriting text", () => {
  for (const text of ["[link](../note.md)", "![image](assets/a.png)", '[ref]: images/a.png', '<img src="./a.png">']) expect(hasRelativeResources(text)).toBe(true);
  for (const text of ["plain text", "[link](https://example.org)", "![image](/a.png)", "[link](#same)"]) expect(hasRelativeResources(text)).toBe(false);
});
test("Copy Relative Path uses the Git root and refuses a non-repository", async () => {
  const dir = await directory();
  expect(await relativeGitPath(path.join(dir, "note.md"))).toBeNull();
  execFileSync("git", ["init", "-q", dir]); await fs.mkdir(path.join(dir, "notes"));
  expect(await relativeGitPath(path.join(dir, "notes/note.md"))).toBe(path.join("notes", "note.md"));
});
test("move preserves exact bytes and replaces only a confirmed destination", async () => {
  const dir = await directory(), source = path.join(dir, "old.md"), target = path.join(dir, "new.mdx");
  await fs.writeFile(source, exact); await fs.writeFile(target, "replace confirmed");
  const state = await destinationState(target);
  await moveDocumentFile(source, target, exact, state);
  expect(await fs.readFile(target, "utf8")).toBe(exact); expect(await fs.stat(source).catch(() => null)).toBeNull();
  expect((await fs.readdir(dir)).sort()).toEqual(["new.mdx"]);
});
test("move rejects a changed source, changed destination and symlink without losing either file", async () => {
  const dir = await directory(), source = path.join(dir, "old.md"), target = path.join(dir, "new.md");
  await fs.writeFile(source, exact);
  await expect(moveDocumentFile(source, target, "stale buffer", { kind: "absent" })).rejects.toThrow();
  await fs.writeFile(target, "unconfirmed");
  await expect(moveDocumentFile(source, target, exact, { kind: "absent" })).rejects.toThrow();
  expect(await fs.readFile(source, "utf8")).toBe(exact); expect(await fs.readFile(target, "utf8")).toBe("unconfirmed");
  if (process.platform !== "win32") {
    const link = path.join(dir, "link.md"); await fs.symlink(source, link);
    await expect(moveDocumentFile(link, path.join(dir, "other.md"), exact, { kind: "absent" })).rejects.toThrow("symbolic link");
  }
});
test("exclusive rename refuses a destination created after dialog validation", async () => {
  const dir = await directory(), source = path.join(dir, "old.md"), target = path.join(dir, "new.md");
  await fs.writeFile(source, exact);
  const io = crossVolume(source, target);
  io.rename = async (a, b) => { await fs.writeFile(target, "arrived later"); await renameNoReplace(a, b); };
  await expect(moveDocumentFile(source, target, exact, { kind: "absent" }, io)).rejects.toThrow();
  expect(await fs.readFile(source, "utf8")).toBe(exact); expect(await fs.readFile(target, "utf8")).toBe("arrived later");
});
test("cross-volume fallback copies and verifies before removing the source", async () => {
  const dir = await directory(), source = path.join(dir, "old.md"), target = path.join(dir, "new.md");
  await fs.writeFile(source, exact);
  let verified = false;
  const io = crossVolume(source, target, { remove: async file => { expect(await fs.readFile(target, "utf8")).toBe(exact); verified = true; await fs.unlink(file); } });
  await moveDocumentFile(source, target, exact, { kind: "absent" }, io);
  expect(verified).toBe(true); expect(await fs.stat(source).catch(() => null)).toBeNull();
});
test("cross-volume copy, verification and removal failures preserve the source and restore a replaced target", async () => {
  for (const stage of ["copy", "verify", "remove"] as const) {
    const dir = await directory(), source = path.join(dir, "old.md"), target = path.join(dir, "new.md");
    await fs.writeFile(source, exact); await fs.writeFile(target, "original destination");
    const io = crossVolume(source, target, stage === "remove" ? { remove: async () => { throw new Error("remove failed"); } } : {
      copy: async (a, b) => { if (stage === "copy") throw new Error("copy failed"); await fs.writeFile(b, "corrupt copy"); },
    });
    await expect(moveDocumentFile(source, target, exact, await destinationState(target), io)).rejects.toThrow();
    expect(await fs.readFile(source, "utf8")).toBe(exact); expect(await fs.readFile(target, "utf8")).toBe("original destination");
    expect((await fs.readdir(dir)).sort()).toEqual(["new.md", "old.md"]);
  }
});
test("session move retains identity, baseline, revision and CLI waiters and reattaches its watcher", async () => {
  const dir = await directory(), source = path.join(dir, "old.md"), target = path.join(dir, "new.md"); await fs.writeFile(source, exact);
  const waiters = new DocumentWaiters(), registry = new DocumentRegistry(id => waiters.closed(id)); registries.push(registry);
  const doc = registry.create(source, exact); doc.setHeadBaseline("old baseline"); const baseline = doc.baseline;
  let closed = false; waiters.add(doc.documentId, () => { closed = true; });
  let changed!: () => void; const change = new Promise<void>(resolve => { changed = resolve; }); doc.watch(() => changed());
  const result = await doc.move(target, await destinationState(target));
  expect(result?.moved).toBe(true); expect(doc.path).toBe(target); expect(doc.baseline).toBe(baseline);
  expect(doc.revisionId).toBe(makeRevisionId(0)); expect(closed).toBe(false);
  await fs.writeFile(target, "outside edit"); await Promise.race([change, new Promise((_, reject) => setTimeout(() => reject(new Error("watcher did not follow move")), 2000))]);
  expect(doc.conflict).toBe(true); registry.remove(doc.documentId); expect(closed).toBe(true);
});

test("duplicate writes the current exact buffer and leaves the original untouched on success and failure", async () => {
  const dir = await directory(), source = path.join(dir, "source.md"), target = path.join(dir, "copy.md");
  await fs.writeFile(source, "original disk text");
  await duplicateDocumentFile(target, exact, { kind: "absent" });
  expect(await fs.readFile(target, "utf8")).toBe(exact); expect(await fs.readFile(source, "utf8")).toBe("original disk text");
  await expect(duplicateDocumentFile(target, "unconfirmed overwrite", { kind: "absent" })).rejects.toThrow();
  expect(await fs.readFile(target, "utf8")).toBe(exact); expect(await fs.readFile(source, "utf8")).toBe("original disk text");
});

test("a move replaces the native recent path without adding a second stale entry", () => {
  const os = isolatedRecents(); os.addRecentDocument("/a.md"); os.addRecentDocument("/b.md");
  moveRecentDocument(os, "darwin", "/a.md", "/renamed.md");
  expect(os.getRecentDocuments()).toEqual(["/b.md", "/renamed.md"]);
});

test("rollback preserves external destination edits and reports the replacement backup", async () => {
  const dir = await directory(), source = path.join(dir, "old.md"), target = path.join(dir, "new.md");
  await fs.writeFile(source, exact); await fs.writeFile(target, "old destination");
  const io = crossVolume(source, target, { remove: async () => { await fs.writeFile(target, "external edit"); throw new Error("remove failed"); } });
  await expect(moveDocumentFile(source, target, exact, await destinationState(target), io)).rejects.toThrow("previous destination is at");
  expect(await fs.readFile(source, "utf8")).toBe(exact); expect(await fs.readFile(target, "utf8")).toBe("external edit");
  const backup = (await fs.readdir(dir)).find(file => file.endsWith(".backup")); expect(backup).toBeDefined();
  expect(await fs.readFile(path.join(dir, backup!), "utf8")).toBe("old destination");
});

test("a clean read-only UTF-8 document can move without writing its contents", async () => {
  const dir = await directory(), source = path.join(dir, "old.md"), target = path.join(dir, "new.md");
  await fs.writeFile(source, exact);
  const registry = new DocumentRegistry(); registries.push(registry);
  const doc = registry.create(source, exact, "read", "This file is locked or not writable. Read only.");
  expect((await doc.move(target, { kind: "absent" }))?.path).toBe(target);
  expect(await fs.readFile(target, "utf8")).toBe(exact);
});

test.skipIf(process.platform === "linux")("case-only renames work on a case-insensitive filesystem and restore the original name on failure", async () => {
  const dir = await directory(), source = path.join(dir, "note.md"), target = path.join(dir, "Note.md");
  await fs.writeFile(source, exact);
  const alias = await destinationState(target);
  if (alias.kind === "absent") return; // A case-sensitive test volume uses the ordinary rename path.
  await moveDocumentFile(source, target, exact, alias);
  expect(await fs.readdir(dir)).toEqual(["Note.md"]); expect(await fs.readFile(target, "utf8")).toBe(exact);
  const io = crossVolume(target, source);
  io.rename = async (a, b) => { if (b === source) throw new Error("rename failed"); await renameNoReplace(a, b); };
  await expect(moveDocumentFile(target, source, exact, await destinationState(source), io)).rejects.toThrow("rename failed");
  expect(await fs.readdir(dir)).toEqual(["Note.md"]); expect(await fs.readFile(target, "utf8")).toBe(exact);
});

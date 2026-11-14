import { expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as metadata from "../src/main/file-metadata";
import { DocumentRegistry } from "../src/main/document-registry";
import { duplicateDocumentFile, moveDocumentFile } from "../src/main/file-actions";
import { renameNoReplace } from "../src/main/file-metadata";

const unsupported = async () => { throw Object.assign(new Error("Operation not supported"), { code: "NOEXCL" }); };
for (const state of ["absent", "arrived", "rename failure", "different volume"] as const) test(`unsupported exclusive rename preserves files: ${state}`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smd-noexcl-"));
  const source = path.join(root, "source.md"), target = path.join(root, "target.md");
  const exact = "\uFEFF# note\r\nlast";
  try {
    await fs.writeFile(source, exact);
    if (state === "arrived") await fs.writeFile(target, "other file");
    const rename = state === "rename failure" || state === "different volume"
      ? async () => { throw Object.assign(new Error("rename failed"), { code: state === "different volume" ? "EXDEV" : "EACCES" }); }
      : fs.rename;
    const result = renameNoReplace(source, target, { exclusive: unsupported, rename });
    if (state === "absent") {
      await result;
      expect(await fs.readFile(target, "utf8")).toBe(exact);
      expect(await fs.stat(source).catch(() => null)).toBeNull();
    } else {
      await expect(result).rejects.toThrow();
      expect(await fs.readFile(source, "utf8")).toBe(exact);
      expect(await fs.readFile(target, "utf8").catch(() => null)).toBe(state === "arrived" ? "other file" : null);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("exclusive rename errors other than unsupported never reserve a destination", async () => {
  let renamed = false;
  await expect(renameNoReplace("unused", "unused", { exclusive: async () => { throw new Error("permission denied"); }, rename: async () => { renamed = true; } })).rejects.toThrow("permission denied");
  expect(renamed).toBe(false);
});

test("unsupported rename supports draft saves, Save As, Recreate, Duplicate and Move", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smd-noexcl-operations-"));
  const registry = new DocumentRegistry();
  const original = metadata.renameNoReplace;
  const rename = spyOn(metadata, "renameNoReplace").mockImplementation((source, target) => original(source, target, { exclusive: unsupported, rename: fs.rename }));
  const exact = "\uFEFFnote\r\nlast";
  try {
    const draft = registry.create(null, exact), first = path.join(root, "draft.md"), second = path.join(root, "save-as.md");
    expect(await draft.save(first, draft.revisionId)).not.toBeNull();
    expect(await draft.save(second, draft.revisionId, true)).not.toBeNull();
    await fs.unlink(second); draft.unavailableReason = "missing"; draft.conflict = true;
    expect(await draft.save(second, draft.revisionId, false, true)).not.toBeNull();
    const duplicate = path.join(root, "duplicate.md"), moved = path.join(root, "moved.md");
    await duplicateDocumentFile(duplicate, exact, { kind: "absent" });
    await moveDocumentFile(duplicate, moved, exact, { kind: "absent" });
    for (const file of [first, second, moved]) expect(await fs.readFile(file, "utf8")).toBe(exact);
  } finally { rename.mockRestore(); registry.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
test("failed fallback does not delete another writer's replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smd-noexcl-race-"));
  const source = path.join(root, "source.md"), target = path.join(root, "target.md");
  try {
    await fs.writeFile(source, "source");
    await expect(renameNoReplace(source, target, { exclusive: unsupported, rename: async () => {
      await fs.rename(target, path.join(root, "reserved"));
      await fs.writeFile(target, "other writer");
      throw new Error("rename failed");
    } })).rejects.toThrow("rename failed");
    expect(await fs.readFile(target, "utf8")).toBe("other writer");
    expect(await fs.readFile(source, "utf8")).toBe("source");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

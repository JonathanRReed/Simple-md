import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import { DragExports } from "../src/main/drag-export";
import { makeDocumentId, makeRevisionId } from "../src/shared/types";
const id = makeDocumentId(1), revision = makeRevisionId(2);

test("drag only receives a finished file for the right document revision", async () => {
  const exports = new DragExports();
  try {
    const prepared = await exports.prepare(id, revision, "plan.md", "html", async () => Buffer.from("<!doctype html><p>Finished</p>"));
    const file = exports.take(prepared.token, id, revision);
    expect(await fs.readFile(file, "utf8")).toBe("<!doctype html><p>Finished</p>");
    expect(prepared.name).toBe("plan.html");
    expect(() => exports.take(prepared.token, makeDocumentId(4), revision)).toThrow();
    expect(() => exports.take(prepared.token, id, makeRevisionId(3))).toThrow();
    await exports.dispose();
    expect(await fs.exists(file)).toBe(false);
  } finally { await exports.dispose(); }
});
test("temporary exports expire after their retention window", async () => {
  const exports = new DragExports(40);
  const prepared = await exports.prepare(id, revision, "note.md", "pdf", async () => Buffer.from("%PDF-finished"));
  const file = exports.take(prepared.token, id, revision);
  expect(await fs.exists(file)).toBe(true);
  const deadline = Date.now() + 2000;
  while (await fs.exists(file) && Date.now() < deadline) await Bun.sleep(10);
  expect(await fs.exists(file)).toBe(false);
  expect(() => exports.take(prepared.token, id, revision)).toThrow();
  await exports.dispose();
});
test("failed or closing exports never become draggable", async () => {
  const exports = new DragExports();
  await expect(exports.prepare(id, revision, "note.md", "html", async () => { throw new Error("Failed"); })).rejects.toThrow("Failed");
  await exports.dispose();
  await expect(exports.prepare(id, revision, "note.md", "html", async () => Buffer.from("No"))).rejects.toThrow("closed");
});

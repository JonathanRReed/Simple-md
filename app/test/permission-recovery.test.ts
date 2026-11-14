import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocumentRegistry } from "../src/main/document-registry";
import { READ_ONLY_NOTICE } from "../src/main/files";
import { makeRevisionId, type DiskChange } from "../src/shared/types";

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(10); }
  expect(check()).toBe(true);
}
test.skipIf(process.platform === "win32")("permission-only changes update an open document in both directions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-permissions-"));
  const file = path.join(dir, "note.md"), registry = new DocumentRegistry();
  await fs.writeFile(file, "before");
  const doc = registry.create(file, "before"), changes: DiskChange[] = [];
  doc.watch(change => changes.push(change));
  try {
    await fs.chmod(file, 0o444);
    await until(() => changes.some(change => change.kind === "permissions" && !!change.readOnlyReason));
    expect(doc.readOnlyReason).toBe(READ_ONLY_NOTICE);
    changes.length = 0;
    await fs.chmod(file, 0o644);
    await until(() => changes.some(change => change.kind === "permissions" && !change.readOnlyReason));
    expect(doc.readOnlyReason).toBeUndefined();
    expect(doc.conflict).toBe(false);
    doc.edit("after", makeRevisionId(1));
    expect(await doc.save(file, doc.revisionId)).not.toBeNull();
    expect(await fs.readFile(file, "utf8")).toBe("after");
  } finally { registry.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

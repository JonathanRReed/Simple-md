import { expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as metadata from "../src/main/file-metadata";
import { DocumentRegistry } from "../src/main/document-registry";
import { makeRevisionId } from "../src/shared/types";

test.skipIf(process.platform !== "darwin")("metadata failure reaches the save result while content still saves", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-metadata-failure-"));
  const file = path.join(dir, "note.md"), registry = new DocumentRegistry();
  await fs.writeFile(file, "before");
  const doc = registry.create(file, "before"); doc.edit("\uFEFFafter\r\nlast", makeRevisionId(1));
  const exchange = metadata.exchangeFiles;
  const copy = spyOn(metadata, "exchangeFiles").mockImplementation(async (source, target, preserve) => ({ ...await exchange(source, target, preserve), metadataCopyFailed: true }));
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await doc.save(file, doc.revisionId);
    expect(result?.metadataCopyFailed).toBe(true);
    const second = await doc.save(file, doc.revisionId);
    expect(second?.metadataCopyFailed).toBe(true);
    expect(await fs.readFile(file)).toEqual(Buffer.from("\uFEFFafter\r\nlast"));
    expect(doc.dirty).toBe(false); expect(copy).toHaveBeenCalled(); expect(log).toHaveBeenCalled();
  } finally { copy.mockRestore(); log.mockRestore(); registry.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

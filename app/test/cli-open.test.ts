import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cliFileError, requireHeading } from "../src/main/cli-open";
import { ENCODING_NOTICE, readDocument } from "../src/main/files";
import { renderBlocks } from "../src/main/markdown";

test("CLI errors distinguish missing files, directories, binary and permission failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-cli-errors-"));
  const message = async (file: string) => {
    try { const doc = await readDocument(file); if (doc.readOnlyReason === ENCODING_NOTICE) throw new Error(ENCODING_NOTICE); }
    catch (error) { return cliFileError(file, error).message; }
  };
  try {
    expect(await message(path.join(dir, "missing.md"))).toContain("File does not exist:");
    expect(await message(dir)).toContain("Cannot open a directory:");
    const binary = path.join(dir, "binary.md"); await fs.writeFile(binary, Buffer.from([0, 1, 255]));
    expect(await message(binary)).toContain("Binary or invalid UTF-8 file:");
    if (process.platform !== "win32") {
      await fs.chmod(binary, 0);
      expect(await message(binary)).toContain("Permission denied:");
      await fs.chmod(binary, 0o600);
    }
    expect(cliFileError("file.md", Object.assign(new Error(), { code: "EPERM" })).message).toBe("Permission denied: file.md");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("CLI heading acceptance uses rendered slugs and rejects unknown headings", async () => {
  const rendered = await renderBlocks("# Same\n\n# Same\n\n# Café\n\n```html\n<h1 id=\"user-content-fake\">Fake</h1>\n```\n", "/tmp/heading.md");
  for (const slug of ["same", "same-1", "café"]) expect(() => requireHeading(rendered.blocks, slug)).not.toThrow();
  for (const slug of ["missing", "same-2", "fake"]) expect(() => requireHeading(rendered.blocks, slug)).toThrow(`Heading not found: #${slug}`);
});

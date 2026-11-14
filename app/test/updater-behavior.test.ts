import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
for (const fixture of ["headless", "mac-headless"]) test(`${fixture}: failed checks, cleanup and installation remain retryable`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-updater-"));
  try {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, `updater/${fixture}.ts`), dir], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (status !== 0) throw new Error(stderr);
    expect(stdout.trim()).toBe("passed");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

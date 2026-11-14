import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("failed automatic checks remain retryable and installer errors keep the app usable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-updater-"));
  try {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "updater/headless.ts"), dir], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, result: stdout.trim() }).toEqual({ status: 0, result: "passed" });
    if (status !== 0) throw new Error(stderr);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

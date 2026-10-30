import { expect, test } from "bun:test";
import path from "node:path";

test("export title and PDF options at the native boundary", async () => {
  const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "fixtures/export-job-boundary.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, output + errors).toBe(0);
});

import { expect, test } from "bun:test";
import path from "node:path";
test("native Find menu commands reach the renderer", async () => {
  const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "fixtures/menu-boundary.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, output + errors).toBe(0);
});

import { expect, test } from "bun:test";
import path from "node:path";
test("daily-driver DOM regressions bundle without starting Electron", async () => {
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "renderer/daily-driver.ts")], target: "browser", format: "iife" });
  expect(built.success, built.logs.join('\n')).toBe(true);
});

import { describe, expect, test } from "bun:test";
import { measureStartup } from "../bench";

const trace = (script: string, expectedName = "expected.md", timeoutMs = 2000) => measureStartup({
  executable: process.execPath, args: ["-e", script], expectedName, timeoutMs,
});

describe("startup measurement", () => {
  test("requires the matching usable document after page load", async () => {
    const ms = await trace(`
      console.error('trace page-loaded: 1ms');
      setTimeout(() => console.error('trace document-usable id=1 name=expected.md: 2ms'), 30);
    `);
    expect(ms).toBeGreaterThanOrEqual(30);
  });

  test("rejects page-load-only and different-document launches", async () => {
    await expect(trace("console.error('trace page-loaded: 1ms')")).rejects.toThrow("usable=false");
    await expect(trace("console.error('trace document-usable id=1 name=other.md: 2ms')")).rejects.toThrow("usable=false");
  });

  test("rejects driver assertions even if a legacy driver exits successfully", async () => {
    await expect(trace(`
      console.error('trace document-usable id=1 name=expected.md: 2ms');
      console.error('driver eval failed: bad document');
    `)).rejects.toThrow("Startup failed");
  });

  test("rejects nonzero exits after a usable mark", async () => {
    await expect(trace(`
      console.error('trace document-usable id=1 name=expected.md: 2ms');
      process.exitCode = 1;
    `)).rejects.toThrow("exit=1");
  });

  test("rejects a missing completion before the deadline", async () => {
    await expect(trace("setInterval(() => {}, 1000)", "expected.md", 50)).rejects.toThrow("timeout=true");
  });
});

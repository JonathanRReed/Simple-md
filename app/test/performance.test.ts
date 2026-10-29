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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureDriverRun } from "../bench";
import { percentile, readableSample, summarizeGate, summarizeEventTiming } from "../scripts/perf-gate";
import { fixtureManifest, perfFixtures, sha256, writePerfFixtures } from "../scripts/perf-fixtures";

describe("performance gate receipts", () => {
  test("uses nearest-rank percentiles and strict targets without mutating samples", () => {
    const samples = [9, 1, 5, 3, 7];
    expect(percentile(samples, 0.5)).toBe(5);
    expect(percentile(samples, 0.95)).toBe(9);
    expect(samples).toEqual([9, 1, 5, 3, 7]);
    expect(summarizeGate([150], 150, 1).status).toBe("fail");
    expect(summarizeGate([149], 150, 20).status).toBe("fail");
    expect(summarizeGate(Array(20).fill(149), 150, 20).status).toBe("pass");
    expect(summarizeGate([], 150, 20).status).toBe("fail");
    expect(() => percentile([NaN], 0.95)).toThrow();
  });
  test("requires a matching arrival and readable marker after the external start", () => {
    const events = [
      { elapsedMs: 1, data: { marker: "first-readable", path: "/old.md" } },
      { elapsedMs: 10, data: { marker: "file-open-arrival", path: "/new.md" } },
      { elapsedMs: 30, data: { marker: "first-readable", path: "/new.md" } },
    ];
    expect(readableSample(events, 5, "/new.md")).toBe(25);
    expect(() => readableSample(events, 5, "/old.md")).toThrow();
    expect(() => readableSample(events, 31, "/new.md")).toThrow();
  });
  test("keeps censored events in the denominator without inventing zero durations", () => {
    const result = summarizeEventTiming({ counts: { keydown: 40, beforeinput: 40 }, events: [{ name: "keydown", duration: 24 }] });
    expect(result.keydown.total).toBe(40);
    expect(result.keydown.p95).toEqual({ lower: 0, upper: 16, upperExclusive: true });
    expect(result.keydown.p99).toEqual({ lower: 24, upper: 24, upperExclusive: false });
    expect(result.beforeinput.p95).toBeNull();
    expect(result.beforeinput.reason).toContain("not exposed");
  });
  test("binds generated and committed fixture bytes to the manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-perf-fixtures-"));
    try {
      const manifest = writePerfFixtures(root);
      expect(manifest).toEqual(fixtureManifest());
      for (const entry of manifest.fixtures) {
        const bytes = fs.readFileSync(path.join(root, entry.name));
        expect(bytes.length).toBe(entry.bytes);
        expect(sha256(bytes)).toBe(entry.sha256);
        if (!entry.generated) expect(fs.readFileSync(path.join(import.meta.dirname, "fixtures/perf", entry.name))).toEqual(bytes);
      }
      expect(perfFixtures()["typing-100k.md"]?.length).toBe(100000);
      expect(Buffer.byteLength(perfFixtures()["ceiling.md"]!)).toBe(20000000);
      expect(perfFixtures()["crlf.md"]?.replaceAll("\r\n", "")).not.toContain("\n");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("times acknowledgements outside the child and rejects errors after markers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-perf-protocol-"));
    const run = (script: string) => measureDriverRun({ executable: process.execPath, args: ["-e", script], cwd: root, env: process.env, logPath: path.join(root, "driver.log"), timeoutMs: 2000 });
    try {
      const result = await run(`console.log('smd-perf {"kind":"barrier","name":"open"}'); process.stdin.once('data', data => { if (data.toString().trim() !== 'open') process.exit(1); setTimeout(() => { console.log('smd-perf {"kind":"marker","marker":"first-readable"}'); process.exit(0); }, 30); });`);
      expect(result.events[1]!.elapsedMs - result.barriers.open!).toBeGreaterThanOrEqual(25);
      await expect(run(`console.log('smd-perf {"kind":"marker","marker":"first-readable"}'); console.error('driver failed');`)).rejects.toThrow("Performance driver failed");
      await expect(run(`console.log('smd-perf not-json'); setInterval(() => {}, 1000);`)).rejects.toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { runDriver } from "../src/main/driver";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
async function steps(steps: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-driver-"));
  dirs.push(dir);
  const file = path.join(dir, "steps.json");
  await fs.writeFile(file, JSON.stringify(steps));
  return file;
}
const received: unknown[] = [];
const win = { webContents: {
  executeJavaScript: async (code: string) => vm.runInNewContext(code),
  sendInputEvent: (input: unknown) => { received.push(input); },
  capturePage: async () => { throw new Error("No screenshot expected."); },
} };

test("driver assertion exceptions reject instead of continuing", async () => {
  const file = await steps([{ eval: 'throw new Error("regression failed")' }, { eval: 'throw new Error("should never execute")' }]);
  await expect(runDriver(win, file, async () => {})).rejects.toThrow("regression failed");
});

test("false assertions fail and input is delivered before clean quit", async () => {
  await expect(runDriver(win, await steps([{ assert: "false" }]), async () => {})).rejects.toThrow("Driver assertion failed");
  received.length = 0;
  await runDriver(win, await steps([{ input: { type: "char", keyCode: "A" } }, { quit: true }, { assert: "false" }]), async () => {});
  expect(received).toEqual([{ type: "char", keyCode: "A" }]);
});

test("HTML steps call the export callback and propagate export failures", async () => {
  const targets: string[] = [];
  const file = await steps([{ html: "/tmp/export.html" }]);
  await runDriver(win, file, async () => {}, async (target) => { targets.push(target); });
  expect(targets).toEqual(["/tmp/export.html"]);
  await expect(runDriver(win, file, async () => {}, async () => { throw new Error("Image export failed"); })).rejects.toThrow("Image export failed");
});

test("menuQuit exercises the application quit request instead of direct driver cleanup", async () => {
  let requests = 0;
  const outcome = await runDriver(win, await steps([{ menuQuit: true }, { assert: "false" }]), async () => {}, undefined, () => { requests++; });
  expect(requests).toBe(1);
  expect(outcome).toBe("menu-quit");
});

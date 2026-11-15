import { expect, test } from "bun:test";
import { updateMenu } from "../src/shared/update-state";
import { UpdateInstall, installMacUpdate } from "../src/main/update-install";
test("update menu reflects checks, download readiness and errors", () => {
  expect(updateMenu({ kind: "idle" }, false).installEnabled).toBe(false);
  expect(updateMenu({ kind: "current" }, false).checkLabel).toContain("Up to Date");
  expect(updateMenu({ kind: "downloading" }, false)).toMatchObject({ installEnabled: false, checkEnabled: false });
  expect(updateMenu({ kind: "ready" }, true).installEnabled).toBe(true);
  expect(updateMenu({ kind: "installing" }, true).installEnabled).toBe(false);
  expect(updateMenu({ kind: "error", message: "Install Failed" }, true)).toMatchObject({ installEnabled: true, checkEnabled: true });
  expect(updateMenu({ kind: "error", message: "Check Failed" }, false).checkLabel).toContain("Check Failed");
});
test("update staging happens after settlement without resource teardown and failure restores editing", async () => {
  const calls: string[] = [];
  const install = new UpdateInstall({ settle: async () => { calls.push("settle"); return true; }, release: () => { calls.push("release"); }, failed: () => { calls.push("failed"); } });
  await install.start(() => { calls.push("stage"); }); expect(calls).toEqual(["settle", "stage"]); expect(install.active).toBe(true);
  install.failed(new Error("stage failed")); expect(calls).toEqual(["settle", "stage", "release", "failed"]); expect(install.active).toBe(false);
  await install.start(() => { throw new Error("launch failed"); }); expect(install.active).toBe(false); expect(calls.slice(-3)).toEqual(["settle", "release", "failed"]);
});
test("cancelled document settlement never hands off to the installer", async () => {
  let launches = 0, released = 0;
  const install = new UpdateInstall({ settle: async () => false, release: () => { released++; }, failed: () => { throw new Error("unexpected failure"); } });
  await install.start(() => { launches++; }); expect(launches).toBe(0); expect(released).toBe(1); expect(install.active).toBe(false);
});

test("macOS hands off after cleanup and exits only on the ten-second fallback", async () => {
  const calls: string[] = [];
  let fallback = () => {};
  await installMacUpdate({ cleanup: async () => { calls.push("cleanup"); }, install: () => { calls.push("Squirrel"); }, exit: () => { calls.push("exit"); } }, (exit, delay) => { expect(delay).toBe(10_000); fallback = exit; });
  expect(calls).toEqual(["cleanup", "Squirrel"]);
  fallback(); expect(calls).toEqual(["cleanup", "Squirrel", "exit"]);
});
test("a handoff that throws after cleanup still exits on the fallback", async () => {
  let fallback: (() => void) | undefined, exited = false;
  await expect(installMacUpdate({ cleanup: async () => {}, install: () => { throw new Error("handoff failed"); }, exit: () => { exited = true; } }, exit => { fallback = exit; })).rejects.toThrow("handoff failed");
  expect(fallback).toBeDefined();
  fallback!(); expect(exited).toBe(true);
});
test("asynchronous cleanup failure never arms Squirrel and permits another install", async () => {
  let attempts = 0, launches = 0, released = 0;
  const install = new UpdateInstall({ settle: async () => true, release() { released++; }, failed() {} });
  const launch = () => installMacUpdate({ cleanup: async () => { if (++attempts === 1) throw new Error("cleanup failed"); }, install() { launches++; }, exit() {} }, () => {});
  await install.start(launch);
  expect(install.active).toBe(false); expect(launches).toBe(0); expect(released).toBe(1);
  await install.start(launch);
  expect(install.active).toBe(true); expect(launches).toBe(1);
});

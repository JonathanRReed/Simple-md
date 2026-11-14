import { expect, test } from "bun:test";
import { updateMenu } from "../src/shared/update-state";
import { UpdateInstall } from "../src/main/update-install";
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
  const calls: string[] = []; let failed!: (error: unknown) => void;
  const install = new UpdateInstall({ settle: async () => { calls.push("settle"); return true; }, release: () => { calls.push("release"); }, failed: () => { calls.push("failed"); } });
  await install.start(fail => { calls.push("stage"); failed = fail; }); expect(calls).toEqual(["settle", "stage"]); expect(install.active).toBe(true);
  failed(new Error("stage failed")); expect(calls).toEqual(["settle", "stage", "release", "failed"]); expect(install.active).toBe(false);
  await install.start(() => { throw new Error("launch failed"); }); expect(install.active).toBe(false); expect(calls.slice(-3)).toEqual(["settle", "release", "failed"]);
});
test("cancelled document settlement never hands off to the installer", async () => {
  let launches = 0, released = 0;
  const install = new UpdateInstall({ settle: async () => false, release: () => { released++; }, failed: () => { throw new Error("unexpected failure"); } });
  await install.start(() => { launches++; }); expect(launches).toBe(0); expect(released).toBe(1); expect(install.active).toBe(false);
});

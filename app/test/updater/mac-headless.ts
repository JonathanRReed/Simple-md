import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2]!;
Object.defineProperty(process, "platform", { value: "darwin" });
Object.defineProperty(process, "resourcesPath", { value: root });
fs.writeFileSync(path.join(root, "app-update.yml"), "fixture");
const native = new EventEmitter();
let staged = () => {};
const stage = Object.assign(native, { checkForUpdates() { staged(); } });
const notices: string[] = [], calls: string[] = [];
let exits = 0, cleanupAttempts = 0, checks = 0;
mock.module("electron", () => ({ app: { isPackaged: true, getPath: () => root, exit() { exits++; } },
  dialog: { showMessageBox: async (options: { message: string }) => { notices.push(options.message); return { response: 1 }; } }, autoUpdater: stage }));
const updater = Object.assign(new EventEmitter(), {
  autoInstallOnAppQuit: true,
  setFeedURL() {},
  checkForUpdates: async () => { checks++; return { isUpdateAvailable: true }; },
  downloadUpdate: async () => { updater.emit("update-downloaded"); },
  quitAndInstall() { calls.push("Squirrel"); },
});
mock.module("electron-updater", () => ({ default: { autoUpdater: updater } }));
const { createUpdater } = await import("../../src/main/updater");
const controller = createUpdater(() => true, async () => { calls.push("settle"); return true; }, () => { calls.push("release"); }, () => {}, async () => {
  calls.push("cleanup"); if (++cleanupAttempts === 1) throw new Error("cleanup failed");
}, async () => {});
try {
  await controller.check(true);
  if (updater.autoInstallOnAppQuit) throw new Error(`Ordinary quit must never install: ${notices.join(";")}`);
  const staging = new Promise<void>(resolve => { staged = resolve; });
  const first = controller.install();
  await staging;
  if (calls.length) throw new Error("Staging froze documents or cleaned up resources");
  native.emit("update-downloaded"); await first;
  if (calls.join(",") !== "settle,cleanup,release" || !controller.menu().checkEnabled || !controller.menu().installEnabled) throw new Error("Cleanup failure did not restore update controls");
  native.emit("before-quit-for-update");
  if (calls.includes("Squirrel")) throw new Error("Cleanup failure armed Squirrel");
  if (!notices.some(message => message.includes("cleanup failed"))) throw new Error("Cleanup failure was not reported");
  await controller.check(true);
  if (checks !== 2) throw new Error("Check for Updates was stuck");
  staged = () => { queueMicrotask(() => native.emit("update-downloaded")); };
  await controller.install();
  if (calls.slice(-3).join(",") !== "settle,cleanup,Squirrel" || exits !== 0) throw new Error("The installer did not own the macOS quit");
  console.log("passed");
} finally { controller.stop(); }

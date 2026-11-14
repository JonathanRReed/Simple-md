import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2]!;
Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(process, "resourcesPath", { value: root });
process.env.APPIMAGE = "fixture";
fs.writeFileSync(path.join(root, "app-update.yml"), "fixture");
const notices: string[] = [];
mock.module("electron", () => ({ app: { isPackaged: true, getPath: () => root }, dialog: { showMessageBox: async (options: { message: string }) => { notices.push(options.message); return { response: 1 }; } }, autoUpdater: new EventEmitter() }));
const native = new EventEmitter();
let checks = 0, launches = 0;
const updater = Object.assign(native, {
  setFeedURL() {},
  checkForUpdates: async () => { checks++; if (checks === 1) throw new Error("offline"); return { isUpdateAvailable: true }; },
  downloadUpdate: async () => { native.emit("update-downloaded"); },
  quitAndInstall: () => { launches++; native.emit("error", new Error("installer launch failed")); },
});
mock.module("electron-updater", () => ({ default: { autoUpdater: updater } }));
const { createUpdater } = await import("../../src/main/updater");
let settles = 0, releases = 0, quitStarted = 0;
const controller = createUpdater(() => true, async () => { settles++; return true; }, () => { releases++; }, () => {}, async () => { quitStarted++; });
await controller.check();
if (fs.existsSync(path.join(root, "update-check.json"))) throw new Error("A failed check consumed the daily allowance");
await controller.check();
if (checks !== 2 || !fs.existsSync(path.join(root, "update-check.json")) || !controller.menu().installEnabled) throw new Error("The automatic retry did not download the update");
await controller.install();
if (quitStarted !== 0 || settles !== 1 || launches !== 1 || releases !== 1 || !notices.some(message => message.includes("installer launch failed"))) throw new Error("An installer failure did not restore the app");
controller.stop();
console.log("passed");

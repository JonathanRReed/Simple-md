import { app, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { updateDecision, updateInterval } from "../shared/update-policy.js";

export function createUpdater(enabled: () => boolean, beforeInstall: () => Promise<boolean>) {
  const stateFile = path.join(app.getPath("userData"), "update-check.json");
  let lastCheck = 0;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) lastCheck = value;
  } catch {}
  let signed = false;
  let busy = false;
  let stopped = false;
  let downloaded = false;
  let updater: typeof import("electron-updater")["autoUpdater"] | undefined;
  const notice = (message: string) => dialog.showMessageBox({ type: "info", message, buttons: ["OK"] });
  async function check(manual = false): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const gate = { packaged: app.isPackaged, platform: process.platform, appImage: !!process.env.APPIMAGE,
        enabled: enabled(), manual, now: Date.now(), lastCheck };
      // Verify the signature only when a check would otherwise run.
      if (process.platform === "darwin" && !signed && updateDecision({ ...gate, signed: true }) === "check") {
        try {
          await promisify(execFile)("/usr/bin/codesign", ["--verify", "--strict", "-R",
            'anchor apple generic and certificate leaf[subject.OU] = "AJ9VWBRNZN"', path.resolve(process.execPath, "../../..")]);
          signed = true;
        } catch {}
      }
      const decision = updateDecision({ ...gate, signed });
      if (decision !== "check") {
        if (manual) await notice(decision === "unsigned" ? "Updates require a signed macOS release." : "Install a release from GitHub to use automatic updates. DEB installations update through your package manager.");
        return;
      }
      if (!updater) {
        const { default: module } = await import("electron-updater");
        updater = module.autoUpdater;
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        updater.disableDifferentialDownload = true;
        // Pin the provider in code. No renderer or user config can supply another feed.
        updater.setFeedURL({ provider: "github", owner: "JonathanRReed", repo: "Simple-md" });
        updater.on("error", error => console.error("simplemd: update failed", error.message));
        updater.on("update-downloaded", () => { downloaded = true; });
      }
      if (stopped) return;
      lastCheck = Date.now();
      fs.writeFileSync(stateFile, JSON.stringify(lastCheck), { mode: 0o600 });
      const result = await updater.checkForUpdates();
      if (result?.isUpdateAvailable && (manual || enabled()) && !stopped) await updater.downloadUpdate();
      if (manual && !stopped) await notice(downloaded ? "Update downloaded. Choose Restart to Install Update from the app menu when ready." : "SimpleMD is up to date.");
    } catch (error) {
      console.error("simplemd: update check failed", error);
      if (manual && !stopped) await notice("Could not check for updates. Try again later.");
    } finally { busy = false; }
  }
  const timer = setInterval(() => { void check(); }, updateInterval);
  timer.unref();
  return {
    check,
    async install(): Promise<void> {
      if (!downloaded || !updater) { await notice("No update is ready. Choose Check for Updates first."); return; }
      const { response } = await dialog.showMessageBox({ type: "question", message: "Restart SimpleMD to install the update?", buttons: ["Cancel", "Restart"], defaultId: 0, cancelId: 0 });
      if (response !== 1 || !await beforeInstall()) return;
      updater.quitAndInstall(false, true);
    },
    stop() { stopped = true; clearInterval(timer); },
  };
}

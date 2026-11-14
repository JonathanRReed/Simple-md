import { UpdateInstall } from "./update-install.js";
import { updateMenu, type UpdateState } from "../shared/update-state.js";
import { app, dialog, autoUpdater as nativeUpdater } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { updateDecision, updateInterval } from "../shared/update-policy.js";

export function createUpdater(enabled: () => boolean, beforeInstall: () => Promise<boolean>, release: () => void, changed: () => void, beginQuit: () => void) {
  const stateFile = path.join(app.getPath("userData"), "update-check.json");
  let lastCheck = 0;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) lastCheck = value;
  } catch { /* no saved check time yet */ }
  let signed = false;
  let busy = false;
  let stopped = false;
  let downloaded = false;
  let state: UpdateState = { kind: "idle" };
  const setState = (next: UpdateState) => { state = next; changed(); };
  let cancelStaging: (() => void) | undefined;
  let updater: typeof import("electron-updater")["autoUpdater"] | undefined;
  const notice = (message: string) => dialog.showMessageBox({ type: "info", message, buttons: ["OK"] });
  const installation = new UpdateInstall({ settle: beforeInstall, release, failed(error) {
    cancelStaging?.(); cancelStaging = undefined;
    setState({ kind: "error", message: "Install Failed" });
    void notice(`Couldn’t install the update. ${error instanceof Error ? error.message : String(error)}`);
  } });
  let quitStarted = false;
  const nativeQuit = () => { if (installation.active && !quitStarted) { quitStarted = true; beginQuit(); } };
  nativeUpdater.on("before-quit-for-update", nativeQuit);
  async function check(manual = false): Promise<void> {
    if (busy || stopped || installation.active) return;
    busy = true;
    try {
      const gate = { packaged: app.isPackaged, metadata: fs.existsSync(path.join(process.resourcesPath, "app-update.yml")), platform: process.platform, appImage: !!process.env.APPIMAGE,
        enabled: enabled(), manual, now: Date.now(), lastCheck };
      // Verify the signature only when a check would otherwise run.
      if (process.platform === "darwin" && !signed && updateDecision({ ...gate, signed: true }) === "check") {
        try {
          await promisify(execFile)("/usr/bin/codesign", ["--verify", "--strict",
            // The leading "=" makes codesign read an inline requirement, not a file path.
            '-R=anchor apple generic and certificate leaf[subject.OU] = "AJ9VWBRNZN"', path.resolve(process.execPath, "../../..")]);
          signed = true;
        } catch { /* unsigned: updates stay off */ }
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
        updater.on("error", error => {
          console.error("simplemd: update failed", error.message);
          if (installation.active) installation.failed(error);
          else setState({ kind: "error", message: "Check Failed" });
        });
        updater.on("update-downloaded", () => { downloaded = true; setState({ kind: "ready" }); });
      }
      if (stopped) return;
      setState({ kind: "checking" });
      const result = await updater.checkForUpdates();
      if (result?.isUpdateAvailable && (manual || enabled()) && !stopped) {
        setState({ kind: "downloading" }); await updater.downloadUpdate();
      }
      if (stopped) return;
      setState({ kind: downloaded ? "ready" : "current" });
      // Failed checks and failed downloads do not consume the daily allowance.
      lastCheck = Date.now();
      fs.writeFileSync(stateFile, JSON.stringify(lastCheck), { mode: 0o600 });
      if (manual && !stopped) await notice(downloaded ? "Update downloaded. Choose Restart to Install Update from the app menu when ready." : "SimpleMD is up to date.");
    } catch (error) {
      setState({ kind: "error", message: "Check Failed" });
      console.error("simplemd: update check failed", error);
      if (manual && !stopped) await notice("Could not check for updates. Try again later.");
    } finally { busy = false; }
  }
  const timer = setInterval(() => { void check(); }, updateInterval);
  timer.unref();
  return {
    menu: () => updateMenu(state, downloaded),
    check,
    async install(): Promise<void> {
      if (installation.active) return;
      if (!downloaded || !updater) { await notice("No update is ready. Choose Check for Updates first."); return; }
      const { response } = await dialog.showMessageBox({ type: "question", message: "Restart SimpleMD to install the update?", buttons: ["Cancel", "Restart"], defaultId: 0, cancelId: 0 });
      if (response !== 1) return;
      const installer = updater;
      await installation.start(failed => {
        setState({ kind: "installing" });
        if (process.platform !== "darwin") { installer.quitAndInstall(false, true); return; }
        // MacUpdater's quitAndInstall installs a persistent native listener before
        // staging. Stage explicitly so a failed attempt cannot later quit the app.
        const ready = () => {
          cancelStaging?.(); cancelStaging = undefined;
          try { installer.quitAndInstall(false, true); } catch (error) { failed(error); }
        };
        const timer = setTimeout(() => failed(new Error("macOS did not finish preparing the update. Try again.")), 60_000);
        cancelStaging = () => { clearTimeout(timer); nativeUpdater.removeListener("update-downloaded", ready); };
        nativeUpdater.once("update-downloaded", ready);
        nativeUpdater.checkForUpdates();
      });
      if (!installation.active && state.kind === "installing") setState({ kind: "ready" });
    },
    stop() { stopped = true; cancelStaging?.(); nativeUpdater.removeListener("before-quit-for-update", nativeQuit); clearInterval(timer); },
  };
}

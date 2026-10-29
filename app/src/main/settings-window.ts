import path from "node:path";
import { BrowserWindow, app, ipcMain, nativeTheme, systemPreferences } from "electron";
import { validateUserPatch } from "../shared/config.js";
import type { ConfigStore } from "./config-store.js";
import type { SettingsSnapshot } from "../shared/settings-window.js";
import { systemFonts } from "./system-fonts.js";
export function systemAccent(): string {
  try { return `#${systemPreferences.getAccentColor()}`; } catch { return "Highlight"; }
}
export function createSettingsWindow(options: { here: string; config: ConfigStore; apply(patch: unknown): void }) {
  let win: BrowserWindow | undefined;
  const snapshot = async (): Promise<SettingsSnapshot> => {
    const fonts = await systemFonts();
    return { settings: options.config.document.settings, file: options.config.file, issues: options.config.document.issues, accent: systemAccent(), ...fonts };
  };
  for (const action of ["get", "set"] as const) {
    ipcMain.handle(`smd:settings-window:${action}`, async (event, patch: unknown) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Untrusted Settings sender.");
      if (action === "set") options.apply(validateUserPatch(patch));
      return snapshot();
    });
  }
  return {
    open(): void {
      if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
      win = new BrowserWindow({ width: 540, height: 720, minWidth: 440, minHeight: 480, show: false, title: "Settings",
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#242424" : "#f3f3f3", minimizable: false, maximizable: false, fullscreenable: false,
        webPreferences: { preload: path.join(options.here, "settings-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      win.setMenu(null);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", event => event.preventDefault());
      win.on("closed", () => { win = undefined; });
      win.once("ready-to-show", () => { if (process.platform === "darwin") void app.dock?.show(); win?.show(); });
      void win.loadFile(path.join(options.here, "renderer", "settings.html"));
    },
    changed(): void {
      const target = win;
      if (!target || target.isDestroyed()) return;
      void snapshot().then(value => { if (!target.isDestroyed()) target.webContents.send("smd:settings-window:changed", value); });
    },
    close(): void { if (win && !win.isDestroyed()) win.destroy(); },
  };
}

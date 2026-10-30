import { ShareMenu, type BrowserWindow } from "electron";

export function shareDocument(window: BrowserWindow, file: string): void {
  if (process.platform === "darwin" && typeof ShareMenu === "function" && !window.isDestroyed()) {
    new ShareMenu({ filePaths: [file] }).popup({ window });
  }
}

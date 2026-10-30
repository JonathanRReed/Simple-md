import { contextBridge, ipcRenderer } from "electron";
import type { SettingsBridge, SettingsSnapshot } from "./shared/settings-window.js";
const bridge: SettingsBridge = {
  get: () => ipcRenderer.invoke("smd:settings-window:get"),
  set: patch => ipcRenderer.invoke("smd:settings-window:set", patch),
  subscribe(callback) {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: SettingsSnapshot) => callback(snapshot);
    ipcRenderer.on("smd:settings-window:changed", listener);
    return () => ipcRenderer.removeListener("smd:settings-window:changed", listener);
  },
};
contextBridge.exposeInMainWorld("simplemdSettings", bridge);

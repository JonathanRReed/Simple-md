import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { Settings } from "../shared/types.js";
import * as store from "./settings-store.js";
import { ConfigStore, configPath, migrateUserSettings } from "./config-store.js";

const file = () => path.join(app.getPath("userData"), "settings.json");
let config: ConfigStore;
export const configStore = (): ConfigStore => config;
export const loadSettings = (): Settings => {
  store.migrateSettings({ userData: app.getPath("userData"), appData: app.getPath("appData"), isolated: process.env.SMD_USER_DATA !== undefined });
  const legacy = store.loadSettings(file());
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file(), "utf8")); } catch { raw = null; }
  config = new ConfigStore(configPath({ platform: process.platform, home: app.getPath("home"), appData: app.getPath("appData"), env: process.env }), migrateUserSettings(raw, legacy));
  return { ...legacy, ...config.document.settings };
};
// settings.json owns application state only. User preferences live in config.
export const saveSettings = (settings: Settings): void => store.saveState(settings, file());
export const { patchSettings, flushSettings } = store;

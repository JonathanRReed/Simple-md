import path from "node:path";
import { app } from "electron";
import type { Settings } from "../shared/types.js";
import * as store from "./settings-store.js";

const file = () => path.join(app.getPath("userData"), "settings.json");
export const loadSettings = (): Settings => store.loadSettings(file());
export const saveSettings = (settings: Settings): void => store.saveSettings(settings, file());
export const { patchSettings, flushSettings } = store;

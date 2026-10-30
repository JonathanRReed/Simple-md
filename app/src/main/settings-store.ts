import { configEntries, normalizeConfigValue, validConfigValue } from "../shared/config-schema.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, ZOOM_MAX, ZOOM_MIN, type Settings } from "../shared/types.js";

const record = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === "object" && !Array.isArray(raw);

export function sanitizeSettings(raw: unknown): Settings {
  const r = record(raw) ? raw : {};
  const s: Settings = { ...DEFAULT_SETTINGS, recents: [] };
  for (const [, def] of configEntries) {
    const value = normalizeConfigValue(def, r[def.setting]);
    if (validConfigValue(def, value)) Object.assign(s, { [def.setting]: value });
  }
  if (r.width === "narrow" || r.width === "normal" || r.width === "wide") s.width = r.width;
  if (r.typeface === "sans" || r.typeface === "serif") s.typeface = r.typeface;
  if (typeof r.zoom === "number" && Number.isFinite(r.zoom)) s.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r.zoom));
  if (Array.isArray(r.recents)) s.recents = r.recents.filter((p): p is string => typeof p === "string").slice(0, 12);
  const b = r.bounds;
  if (record(b) && typeof b.x === "number" && Number.isFinite(b.x) && typeof b.y === "number" && Number.isFinite(b.y) &&
      typeof b.width === "number" && Number.isFinite(b.width) && typeof b.height === "number" && Number.isFinite(b.height) &&
      b.width >= 420 && b.width <= 20_000 && b.height >= 320 && b.height <= 20_000) {
    s.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  }
  return s;
}

export function loadSettings(settingsFile: string): Settings {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8")));
  } catch {
    return sanitizeSettings(null);
  }
}

export function migrateSettings({ userData, appData, isolated }: { userData: string; appData: string; isolated: boolean }): void {
  if (isolated) return;
  const source = path.join(appData, "Simple-md", "settings.json");
  const target = path.join(userData, "settings.json");
  if (fs.existsSync(target) || !fs.existsSync(source)) return;
  try {
    fs.mkdirSync(userData, { recursive: true });
    // Recents live in settings.json. Exclusive copy keeps an existing new profile authoritative.
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } catch {
    // An unreadable old profile must not prevent startup.
  }
}

let timer: NodeJS.Timeout | undefined;
let pending: { file: string; settings: Settings | Pick<Settings, "recents" | "bounds" | "zoom"> } | undefined;

export function flushSettings(): void {
  clearTimeout(timer);
  if (!pending) return;
  const entry = pending;
  pending = undefined;
  const tmp = `${entry.file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(entry.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(entry.settings, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, entry.file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    console.error("simple-md: could not save settings", err);
  }
}

export function saveSettings(s: Settings, settingsFile: string): void {
  clearTimeout(timer);
  pending = { file: settingsFile, settings: sanitizeSettings(s) };
  timer = setTimeout(flushSettings, 150);
  timer.unref();
}

export function patchSettings(current: Settings, patch: unknown): Settings {
  return sanitizeSettings({ ...current, ...(record(patch) ? patch : {}) });
}

export function saveState(settings: Settings, settingsFile: string): void {
  clearTimeout(timer);
  pending = { file: settingsFile, settings: { recents: settings.recents, bounds: settings.bounds, zoom: settings.zoom } };
  timer = setTimeout(flushSettings, 150);
  timer.unref();
}

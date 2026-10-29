import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushSettings, loadSettings, migrateSettings, patchSettings, sanitizeSettings, saveSettings } from "../src/main/settings-store";

const dirs: string[] = [];
afterEach(() => { flushSettings(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function settingsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-settings-"));
  dirs.push(dir);
  return path.join(dir, "settings.json");
}

test("login is opt-in for missing, corrupt and non-boolean settings", () => {
  for (const raw of [null, [], {}, { launchAtLogin: "yes" }, { launchAtLogin: 1 }]) {
    expect(sanitizeSettings(raw).launchAtLogin).toBe(false);
  }
  expect(sanitizeSettings({ launchAtLogin: true }).launchAtLogin).toBe(true);
  expect(loadSettings(settingsFile()).launchAtLogin).toBe(false);
});

test("untrusted settings cannot inject invalid bounds or crash shortcut setup", () => {
  const s = sanitizeSettings({ bounds: { x: 0, y: 0, width: -1, height: 600 }, shortcut: 42, zoom: Infinity, mode: "unknown", recents: [3, "note.md"] });
  expect(s.bounds).toBeUndefined();
  expect(s.shortcut).toBe("CommandOrControl+Shift+Space");
  expect(s.zoom).toBe(1);
  expect(s.mode).toBe("live");
  expect(s.recents).toEqual(["note.md"]);
  expect(patchSettings(s, { zoom: 50 }).zoom).toBe(1.8);
});

test("pending settings survive immediate quit when flushed", () => {
  const file = settingsFile();
  saveSettings(sanitizeSettings({ mode: "source", launchAtLogin: false }), file);
  flushSettings();
  expect(loadSettings(file).mode).toBe("source");
  expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]);
});

function migrationProfile() {
  const appData = path.dirname(settingsFile());
  const userData = path.join(appData, "SimpleMD");
  const oldData = path.join(appData, "Simple-md");
  const oldFile = path.join(oldData, "settings.json");
  const newFile = path.join(userData, "settings.json");
  return { appData, userData, oldData, oldFile, newFile, isolated: false };
}

test("a fresh install does not create migrated settings", () => {
  const profile = migrationProfile();
  migrateSettings(profile);
  expect(fs.existsSync(profile.userData)).toBe(false);
  expect(loadSettings(profile.newFile)).toEqual(sanitizeSettings(null));
});

test("migration copies settings and recents, leaves caches and the old profile untouched, and is idempotent", () => {
  const profile = migrationProfile();
  fs.mkdirSync(profile.oldData);
  const oldSettings = JSON.stringify({ theme: "dark", mode: "source", recents: ["/notes/a.md", "/notes/b.md"] });
  fs.writeFileSync(profile.oldFile, oldSettings);
  fs.writeFileSync(path.join(profile.oldData, "render-cache.json"), "old cache");
  fs.mkdirSync(path.join(profile.oldData, "Cache"));
  fs.writeFileSync(path.join(profile.oldData, "Cache", "data"), "chromium cache");
  const before = fs.statSync(profile.oldFile);
  migrateSettings(profile);
  expect(fs.readFileSync(profile.newFile, "utf8")).toBe(oldSettings);
  expect(loadSettings(profile.newFile).recents).toEqual(["/notes/a.md", "/notes/b.md"]);
  expect(loadSettings(profile.newFile).mode).toBe("source");
  expect(fs.readdirSync(profile.userData)).toEqual(["settings.json"]);
  const modified = fs.statSync(profile.newFile).mtimeMs;
  migrateSettings(profile);
  expect(fs.statSync(profile.newFile).mtimeMs).toBe(modified);
  expect(fs.readFileSync(profile.oldFile, "utf8")).toBe(oldSettings);
  expect(fs.statSync(profile.oldFile).mtimeMs).toBe(before.mtimeMs);
  expect(fs.readFileSync(path.join(profile.oldData, "Cache", "data"), "utf8")).toBe("chromium cache");
});

test("existing new settings and recents win over the old profile", () => {
  const profile = migrationProfile();
  fs.mkdirSync(profile.oldData);
  fs.mkdirSync(profile.userData);
  fs.writeFileSync(profile.oldFile, JSON.stringify({ theme: "dark", recents: ["/old.md"] }));
  const newSettings = JSON.stringify({ theme: "light", recents: ["/new.md"] });
  fs.writeFileSync(profile.newFile, newSettings);
  migrateSettings(profile);
  expect(fs.readFileSync(profile.newFile, "utf8")).toBe(newSettings);
  expect(loadSettings(profile.newFile).recents).toEqual(["/new.md"]);
});

test("an existing new cache does not prevent settings migration", () => {
  const profile = migrationProfile();
  fs.mkdirSync(profile.oldData);
  fs.mkdirSync(profile.userData);
  fs.writeFileSync(profile.oldFile, JSON.stringify({ theme: "dark" }));
  fs.writeFileSync(path.join(profile.userData, "render-cache.json"), "new cache");
  migrateSettings(profile);
  expect(loadSettings(profile.newFile).theme).toBe("dark");
  expect(fs.readFileSync(path.join(profile.userData, "render-cache.json"), "utf8")).toBe("new cache");
});

test("an unreadable old settings path does not prevent startup or leave new settings", () => {
  const profile = migrationProfile();
  fs.mkdirSync(profile.oldFile, { recursive: true });
  expect(() => migrateSettings(profile)).not.toThrow();
  expect(fs.existsSync(profile.newFile)).toBe(false);
  expect(loadSettings(profile.newFile)).toEqual(sanitizeSettings(null));
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("permission-denied old settings leave the old file intact", () => {
  const profile = migrationProfile();
  fs.mkdirSync(profile.oldData);
  fs.writeFileSync(profile.oldFile, "old settings");
  fs.chmodSync(profile.oldFile, 0o000);
  try {
    expect(() => migrateSettings(profile)).not.toThrow();
    expect(fs.existsSync(profile.newFile)).toBe(false);
    expect(fs.statSync(profile.oldFile).mode & 0o777).toBe(0);
  } finally {
    fs.chmodSync(profile.oldFile, 0o600);
  }
  expect(fs.readFileSync(profile.oldFile, "utf8")).toBe("old settings");
});

test("SMD_USER_DATA isolation skips migration even with an old profile", () => {
  const profile = migrationProfile();
  fs.mkdirSync(profile.oldData);
  fs.writeFileSync(profile.oldFile, JSON.stringify({ recents: ["/private.md"] }));
  migrateSettings({ ...profile, isolated: true });
  expect(fs.existsSync(profile.userData)).toBe(false);
});

test("remote images default on and persist an explicit boolean preference", () => {
  for (const raw of [null, {}, { remoteImages: "false" }, { remoteImages: 0 }]) expect(sanitizeSettings(raw).remoteImages).toBe(true);
  const file = settingsFile();
  saveSettings(sanitizeSettings({ remoteImages: false }), file);
  flushSettings();
  expect(loadSettings(file).remoteImages).toBe(false);
  expect(patchSettings(loadSettings(file), { remoteImages: true }).remoteImages).toBe(true);
});

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushSettings, loadSettings, patchSettings, sanitizeSettings, saveSettings } from "../src/main/settings-store";

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

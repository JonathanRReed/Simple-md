import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampSidebarWidth, configDefaults } from "../src/shared/config-schema";
import { parseConfig, serializeConfig, validateUserPatch } from "../src/shared/config";
import { ConfigStore, configPath } from "../src/main/config-store";
import { sanitizeSettings } from "../src/main/settings-store";

test("chrome motion defaults to subtle and only accepts subtle or off", () => {
  expect(configDefaults.uiMotion).toBe("subtle");
  for (const uiMotion of ["subtle", "off"] as const) {
    expect(parseConfig(serializeConfig("", { uiMotion })).settings.uiMotion).toBe(uiMotion);
    expect(validateUserPatch({ uiMotion })).toEqual({ uiMotion });
    expect(sanitizeSettings({ uiMotion }).uiMotion).toBe(uiMotion);
  }
  expect(parseConfig("ui-motion = fast").issues).toHaveLength(1);
  expect(() => validateUserPatch({ uiMotion: true })).toThrow();
});

test("tab settings round trip and sidebar width clamps at every config boundary", () => {
  expect(configDefaults.tabStyle).toBe("top"); expect(configDefaults.sidebarWidth).toBe(180);
  const patch = { tabStyle: "sidebar", sidebarWidth: 301, sidebarCollapsed: true, zenMode: true } as const;
  expect(parseConfig(serializeConfig("# Tabs\r\n", patch)).settings).toMatchObject(patch);
  for (const [input, expected] of [[1, 140], [900, 420], [250.7, 251]]) {
    expect(clampSidebarWidth(input!)).toBe(expected!);
    expect(parseConfig(`sidebar-width = ${input}`).settings.sidebarWidth).toBe(expected!);
    expect(parseConfig(serializeConfig("", { sidebarWidth: input! })).settings.sidebarWidth).toBe(expected!);
    expect(validateUserPatch({ sidebarWidth: input! }).sidebarWidth).toBe(expected!);
    expect(sanitizeSettings({ sidebarWidth: input! }).sidebarWidth).toBe(expected!);
  }
  expect(clampSidebarWidth(NaN)).toBe(180);
  expect(parseConfig("tab-style = tree\nsidebar-width = Infinity\nsidebar-collapsed = yes").issues).toHaveLength(3);
  expect(() => validateUserPatch({ sidebarWidth: Infinity })).toThrow();
  expect(() => validateUserPatch({ tabStyle: "tree" })).toThrow();
});
test("config preserves comments, unknown lines, order, quotes and CRLF", () => {
  const source = '# My setup\r\nreading-font-family = "A # Font" # Keep this\r\nfuture-key = x\r\nautosave = false\r\n';
  expect(serializeConfig(source, {})).toBe(source);
  const edited = serializeConfig(source, { readingFontFamily: "Iowan Old Style", autosave: true });
  expect(edited).toBe(source.replace('"A # Font"', '"Iowan Old Style"').replace('false', 'true'));
  expect(parseConfig(source).settings.readingFontFamily).toBe("A # Font");
  expect(parseConfig(edited).issues).toEqual([{ line: 3, key: "future-key", message: "Unknown key: future-key." }]);
  expect(parseConfig(serializeConfig("", configDefaults)).settings).toEqual(configDefaults);
});
test("invalid config values report their lines and use defaults", () => {
  const parsed = parseConfig('autosave = yes\nreading-font-size = 0\nreading-line-height = Infinity\ntheme-light = github-dark\nreading-font-family = "bad\\nfont"\nmissing delimiter\nmode = "unclosed\n');
  expect(parsed.issues.map(issue => issue.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(parsed.settings).toEqual(configDefaults);
  expect(() => validateUserPatch({ contentWidth: -1 })).toThrow();
  expect(() => validateUserPatch({ recents: [] })).toThrow();
});
test("paths respect XDG, Windows app data and isolated test profiles", () => {
  const input = { home: "/home/me", appData: "/app-data", env: {} };
  expect(configPath({ ...input, platform: "darwin" })).toBe(path.join("/home/me", ".config", "simplemd", "config"));
  expect(configPath({ ...input, platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } })).toBe(path.join("/xdg", "simplemd", "config"));
  expect(configPath({ ...input, platform: "win32" })).toBe(path.join("/app-data", "SimpleMD", "config"));
  expect(configPath({ ...input, platform: "darwin", env: { SMD_USER_DATA: "/isolated" } })).toBe(path.join("/isolated", "config"));
});
test("watcher follows atomic replacements, deletion and recreation; Settings merges the latest disk edit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simplemd-config-"));
  const file = path.join(dir, "config");
  const store = new ConfigStore(file, configDefaults, () => {});
  const seen: string[] = [];
  store.watch(settings => seen.push(settings.readingStyle));
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("Watcher timed out"); await Bun.sleep(20); }
  };
  try {
    fs.writeFileSync(`${file}.tmp`, '# External\nreading-style = github\nunknown-key = keep\n');
    fs.renameSync(`${file}.tmp`, file);
    await until(() => seen.includes("github"));
    fs.appendFileSync(file, 'vim = true\n');
    expect(store.set({ autosave: false }).vim).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("unknown-key = keep");
    fs.unlinkSync(file);
    await until(() => seen.at(-1) === "editorial");
    expect(store.document.issues[0]?.message).toContain("Cannot read config");
    fs.writeFileSync(file, "reading-style = github\n");
    await until(() => seen.at(-1) === "github");
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("duplicate keys update together without reordering; an unrelated patch retains invalid values", () => {
  const source = "autosave = true # first\nreading-font-size = wrong\nautosave = false # last";
  const next = serializeConfig(source, { autosave: true });
  expect(next).toBe(source.replace("false", "true"));
  expect(parseConfig(next).issues[0]?.key).toBe("reading-font-size");
});
test("legacy font and width migrate only when explicitly stored", async () => {
  const { migrateUserSettings } = await import("../src/main/config-store");
  const { sanitizeSettings, saveState, flushSettings } = await import("../src/main/settings-store");
  expect(migrateUserSettings(null, sanitizeSettings(null))).toEqual(configDefaults);
  const raw = { typeface: "sans", width: "wide", mode: "source", remoteImages: false };
  const migrated = migrateUserSettings(raw, sanitizeSettings(raw));
  expect(migrated.readingFontFamily).toBe("system-ui");
  expect(migrated.contentWidth).toBe(100);
  expect(migrated.remoteImages).toBe(false);
  expect(migrated.mode).toBe("source");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simplemd-state-"));
  try {
    const file = path.join(dir, "settings.json");
    saveState({ ...sanitizeSettings(raw), recents: ["note.md"], zoom: 1.2 }, file); flushSettings();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ recents: ["note.md"], zoom: 1.2, pinnedPaths: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("config writes preserve symlinks and update their real targets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-config-link-"));
  try {
    const target = path.join(dir, "target"); const file = path.join(dir, "config");
    fs.writeFileSync(target, "# Keep\nautosave = false\n", { mode: 0o640 }); fs.symlinkSync(target, file);
    const mode = fs.statSync(target).mode & 0o777;
    const store = new ConfigStore(file, configDefaults, () => {});
    store.set({ autosave: true }); store.close();
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("# Keep\nautosave = true\n");
    expect(fs.statSync(target).mode & 0o777).toBe(mode);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("config rejects oversized files without parsing them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-config-large-"));
  try {
    const file = path.join(dir, "config"); fs.writeFileSync(file, "#".repeat(1_000_000));
    const store = new ConfigStore(file, configDefaults, () => {});
    expect(store.document.issues[0]?.message).toContain("under 1 MB");
    expect(() => store.set({ autosave: false })).toThrow("under 1 MB"); store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test.skipIf(process.platform === "win32")("config rejects FIFO reads without blocking startup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-config-fifo-"));
  try {
    const file = path.join(dir, "config");
    const { execFileSync } = await import("node:child_process"); execFileSync("mkfifo", [file]);
    const source = `import {ConfigStore} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/main/config-store.ts"))}; import {configDefaults} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/shared/config-schema.ts"))}; const s = new ConfigStore(${JSON.stringify(file)}, configDefaults, () => {}); if (!s.document.issues[0]?.message.includes('regular file')) process.exit(2); s.close();`;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 2000);
    try { expect(await child.exited).toBe(0); } finally { clearTimeout(timer); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

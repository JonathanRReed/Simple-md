import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDefaults } from "../src/shared/config-schema";
import { parseConfig, serializeConfig, validateUserPatch } from "../src/shared/config";
import { ConfigStore, configPath } from "../src/main/config-store";
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
  expect(configPath({ ...input, platform: "darwin" })).toBe("/home/me/.config/simplemd/config");
  expect(configPath({ ...input, platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } })).toBe("/xdg/simplemd/config");
  expect(configPath({ ...input, platform: "win32" })).toBe("/app-data/SimpleMD/config");
  expect(configPath({ ...input, platform: "darwin", env: { SMD_USER_DATA: "/isolated" } })).toBe("/isolated/config");
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

import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { existingPinnedPaths } from "../src/main/pinned-tabs";
import { flushSettings, loadSettings, sanitizeSettings, saveState } from "../src/main/settings-store";
import { TabLayout } from "../src/shared/tab-layout";
import { tabCommands } from "../src/shared/tab-commands";
import { tabRows } from "../src/shared/tab-presentation";
import { parseConfig, serializeConfig } from "../src/shared/config";
import { DEFAULT_SETTINGS, makeDocumentId } from "../src/shared/types";

test("pins persist as app state and restore only existing files in order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-pins-"));
  try {
    const a = path.join(dir, "a.md"), b = path.join(dir, "b.mdx"), missing = path.join(dir, "missing.md");
    fs.writeFileSync(a, "# A"); fs.writeFileSync(b, "# B");
    const state = path.join(dir, "settings.json");
    const settings = sanitizeSettings({ pinnedPaths: [b, missing, a, dir, b, "relative.md", 42] });
    saveState(settings, state); flushSettings();
    expect(loadSettings(state).pinnedPaths).toEqual([b, missing, a, dir]);
    expect(await existingPinnedPaths(loadSettings(state).pinnedPaths)).toEqual([b, a]);
    expect(serializeConfig("", settings)).not.toContain("pinned");
    expect(parseConfig("pinned-paths = []").issues[0]?.message).toContain("Unknown key");
    expect(JSON.parse(fs.readFileSync(state, "utf8"))).not.toHaveProperty("zenMode");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pins stay first, reorder within sections, unpin, and retain active panes", () => {
  const layout = new TabLayout();
  const a = makeDocumentId(1), b = makeDocumentId(2), c = makeDocumentId(3), d = makeDocumentId(4);
  for (const id of [a!, b!, c!, d!]) layout.add(id);
  layout.pin(c!, true); layout.pin(a!, true);
  expect(layout.state.tabs).toEqual([c, a, b, d]);
  layout.pin(a!, true, c!); expect(layout.state.tabs).toEqual([a, c, b, d]);
  layout.pin(d!, false, b!); expect(layout.state.tabs).toEqual([a, c, d, b]);
  layout.pin(c!, false, b!); expect(layout.state.tabs).toEqual([a, d, c, b]);
  expect(layout.state.pinned).toEqual([a]);
  expect(layout.active?.documentId).toBe(d);
  layout.pin(a!, false); expect(layout.state.tabs).toEqual([d, c, b, a]);
  expect(layout.state.pinned).toEqual([]);
});

test("normal close leaves a pin, switches away and never removes the last pin", () => {
  const layout = new TabLayout(), a = makeDocumentId(1), b = makeDocumentId(2);
  layout.add(a); layout.add(b); layout.pin(a, true); layout.activate(a);
  expect(layout.leavePinned(a)).toBe(true);
  expect(layout.active?.documentId).toBe(b); expect(layout.state.tabs).toEqual([a, b]);
  expect(layout.leavePinned(a)).toBe(true); expect(layout.active?.documentId).toBe(b);
  expect(layout.leavePinned(b)).toBe(false);
  layout.remove(b); expect(layout.leavePinned(a)).toBe(true); expect(layout.state.tabs).toEqual([a]);
  layout.remove(a); expect(layout.state.pinned).toEqual([]);
});

test("pinned rows and commands use file identity and pin-first keyboard order", () => {
  const layout = new TabLayout(), a = makeDocumentId(1), b = makeDocumentId(2);
  layout.add(a); layout.add(b); layout.pin(b, true);
  const names = layout.state.tabs.map(id => ({ name: `${id}.md`, path: `/notes/${id}.md`, dirty: false }));
  expect(tabRows(layout.state, names).map(row => [row.id, row.pinned])).toEqual([[b, true], [a, false]]);
  expect(layout.state.tabs[0]).toBe(b);
  const settings = { ...DEFAULT_SETTINGS, pinnedPaths: ["/notes/2.md"] };
  expect(tabCommands(settings, "/notes/2.md").map(item => item.command)).toEqual(["toggle-zen", "toggle-pin-tab", "close-pinned-tab"]);
  expect(tabCommands(settings, "/notes/1.md").map(item => item.label)).toContain("Pin Tab");
  expect(tabCommands(settings, null)).toHaveLength(1);
});

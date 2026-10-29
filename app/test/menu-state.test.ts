import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import { changesMenuState, menuState } from "../src/main/menu-state";
test("bounds, zoom and document typography do not rebuild native menus", () => {
  const before = menuState(DEFAULT_SETTINGS, "live", true);
  expect(menuState({ ...DEFAULT_SETTINGS, bounds: { x: 1, y: 2, width: 800, height: 600 }, zoom: 1.2, readingFontSize: 22 }, "live", true)).toEqual(before);
});
test("Git action follows the document path and stays available after a failed read", () => {
  const failed = { available: false, reason: "This file is outside a Git repository." } as const;
  expect(changesMenuState(true, { available: true, active: false })).toMatchObject({ enabled: true, checked: false });
  expect(changesMenuState(true, failed)).toEqual({ enabled: true, checked: false, toolTip: failed.reason });
  expect(changesMenuState(false, failed).enabled).toBe(false);
  expect(changesMenuState(false, { available: true, active: true }).checked).toBe(false);
  const before = menuState(DEFAULT_SETTINGS, "live", true, failed);
  expect(menuState(DEFAULT_SETTINGS, "live", false, failed).application).not.toBe(before.application);
  expect(menuState(DEFAULT_SETTINGS, "live", true, { available: true, active: true }).application).not.toBe(before.application);
  expect(menuState(DEFAULT_SETTINGS, "live", false, failed).tray).toBe(before.tray);
});
test("recents rebuild app and OS menus while pane mode only rebuilds the app menu", () => {
  const before = menuState(DEFAULT_SETTINGS, "live", true);
  const mode = menuState(DEFAULT_SETTINGS, "source", true);
  expect(mode.application).not.toBe(before.application); expect(mode.tray).toBe(before.tray); expect(mode.recents).toBe(before.recents);
  const recent = menuState({ ...DEFAULT_SETTINGS, recents: ["/tmp/file.md"] }, "live", true);
  expect(recent.application).not.toBe(before.application); expect(recent.recents).not.toBe(before.recents); expect(recent.tray).toBe(before.tray);
  for (const patch of [{ autosave: false }, { vim: true }, { spellcheck: false }, { theme: "dark" as const }, { readingStyle: "github" as const }]) expect(menuState({ ...DEFAULT_SETTINGS, ...patch }, "live", true).application).not.toBe(before.application);
  expect(menuState(DEFAULT_SETTINGS, "live", false).application).not.toBe(before.application);
});

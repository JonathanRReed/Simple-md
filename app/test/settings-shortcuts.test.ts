import { expect, test } from "bun:test";
import { normalizeShortcut, replaceShortcut } from "../src/main/shortcuts";
import { patchSettings, sanitizeSettings } from "../src/main/settings-store";

test("shortcut input accepts Electron keys and normalizes aliases", () => {
  expect(normalizeShortcut(" shift + cmdorctrl + space ")).toBe("CommandOrControl+Shift+Space");
  expect(normalizeShortcut("Ctrl++")).toBe("Control+Plus");
  expect(normalizeShortcut("Control+Alt+F24")).toBe("Control+Alt+F24");
  expect(normalizeShortcut("Control+num3")).toBe("Control+NUM3");
  expect(normalizeShortcut("Ctrl+,")).toBe("Control+,");
});

test("invalid shortcut input rejects the patch without changing current settings", () => {
  const current = sanitizeSettings({ shortcut: "Control+Shift+Space", theme: "dark" });
  for (const shortcut of ["", "Ctrl+", "Ctrl+Shift", "Control+BogusKey", "Ctrl+Control+Space", 7]) {
    expect(() => patchSettings(current, { shortcut, theme: "light" })).toThrow();
    expect(current.shortcut).toBe("Control+Shift+Space");
    expect(current.theme).toBe("dark");
  }
});

test("unavailable or throwing shortcut registration preserves the old binding", () => {
  const events: string[] = [];
  const api = { register: (value: string) => { events.push(`register ${value}`); return false; }, unregister: (value: string) => { events.push(`unregister ${value}`); } };
  expect(() => replaceShortcut("Control+Shift+Space", "Control+F9", api, () => {})).toThrow("unavailable");
  expect(events).toEqual(["register Control+F9"]);
  api.register = () => { throw new Error("Invalid accelerator"); };
  expect(() => replaceShortcut("Control+Shift+Space", "Control+F9", api, () => {})).toThrow("previous shortcut is still active");
  expect(events).toEqual(["register Control+F9"]);
});

test("replacement registers first, releases the previous binding, and retains the callback", () => {
  const events: string[] = [];
  let trigger: () => void = () => {};
  const api = {
    register: (value: string, callback: () => void) => { events.push(`register ${value}`); trigger = callback; return true; },
    unregister: (value: string) => { events.push(`unregister ${value}`); },
  };
  expect(replaceShortcut("Control+Shift+Space", "Ctrl+F9", api, () => { events.push("peek"); })).toBe("Control+F9");
  trigger();
  expect(events).toEqual(["register Control+F9", "unregister Control+Shift+Space", "peek"]);
});

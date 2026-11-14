import { expect, test } from "bun:test";
import { applySettings } from "../src/main/settings-apply";
import { DEFAULT_SETTINGS } from "../src/shared/types";

test("failed login changes still apply this and later config edits without throwing", () => {
  let current = { ...DEFAULT_SETTINGS };
  let calls = 0;
  const actions = {
    login() { calls++; throw new Error("system declined"); },
    persist: (next: typeof current) => next,
    commit(next: typeof current) { current = next; },
  };
  expect(applySettings(current, { launchAtLogin: true, zoom: 1.2 }, false, actions)?.message).toBe("system declined");
  expect(current.launchAtLogin).toBe(true); expect(current.zoom).toBe(1.2);
  expect(applySettings(current, { zoom: 1.4 }, false, actions)).toBeUndefined();
  expect(current.zoom).toBe(1.4); expect(calls).toBe(1);
});
test("settings reports write failures to UI callers without throwing", () => {
  expect(applySettings(DEFAULT_SETTINGS, { launchAtLogin: true }, true, {
    login() {}, persist() { throw new Error("read-only config"); }, commit() {},
  })?.message).toBe("read-only config");
  expect(applySettings(DEFAULT_SETTINGS, {}, false, { login() {}, persist: next => next, commit() { throw new Error("closed window"); } })?.message).toBe("closed window");
});

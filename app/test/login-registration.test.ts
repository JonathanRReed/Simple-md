import { expect, test } from "bun:test";
import { loginEnabled, readLinuxLogin, verifyLoginRegistration, linuxLoginFile } from "../src/main/login-registration";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
test("login display uses actual registration and failed changes report an error", () => {
  expect(loginEnabled("darwin", { openAtLogin: true, status: "requires-approval" })).toBe(false);
  expect(loginEnabled("darwin", { openAtLogin: true, status: "enabled" })).toBe(true);
  expect(loginEnabled("win32", { openAtLogin: true, executableWillLaunchAtLogin: false })).toBe(false);
  expect(loginEnabled("win32", { openAtLogin: true, executableWillLaunchAtLogin: true })).toBe(true);
  expect(loginEnabled("win32", { openAtLogin: false, executableWillLaunchAtLogin: true })).toBe(true);
  expect(() => verifyLoginRegistration(true, false)).toThrow("not enabled"); expect(() => verifyLoginRegistration(false, true)).toThrow("not disabled");
});
test("Linux login query reads the registered entry, including system disables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-login-"));
  try {
    expect(readLinuxLogin(dir, "/app")).toBe(false); fs.mkdirSync(path.dirname(linuxLoginFile(dir)), { recursive: true });
    fs.writeFileSync(linuxLoginFile(dir), '[Desktop Entry]\nExec="/app" --background\n'); expect(readLinuxLogin(dir, "/app")).toBe(true);
    fs.appendFileSync(linuxLoginFile(dir), "Hidden=true\n"); expect(readLinuxLogin(dir, "/app")).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

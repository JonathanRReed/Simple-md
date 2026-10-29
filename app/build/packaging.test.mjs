import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appDir, nativePlan } from "./native.mjs";
import { localEnvironment, packageMode, unsignedConfig } from "./local-pack.mjs";
import { desktopEntry } from "../integrations/linux/desktop-entry.mjs";

describe("host-only packaging", () => {
  for (const [platform, arch, host] of [
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
    ["win32", "arm64", "aarch64-pc-windows-msvc"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["linux", "arm64", "aarch64-unknown-linux-gnu"],
  ]) {
    test(`${platform}/${arch} packages the exact helper`, () => {
      const plan = nativePlan(host, platform, arch);
      expect(plan.args).toContain("--locked");
      expect(plan.args[plan.args.indexOf("--target") + 1]).toBe(host);
      expect(plan.args[plan.args.indexOf("--target-dir") + 1]).toBe(path.join(appDir, "native", "target"));
      expect(plan.binary).toContain(path.join(host, "release", plan.executable));
      expect(plan.executable.endsWith(".exe")).toBe(platform === "win32");
      expect(plan.executable).toBe(platform === "win32" ? "simplemd-helper.exe" : "simplemd-helper");
      expect(unsignedConfig(plan).extraResources[0]).toEqual({ from: plan.binary, to: `native/${plan.executable}` });
    });
  }
  test("rejects mismatched toolchains and unsupported architectures", () => {
    expect(() => nativePlan("x86_64-apple-darwin", "darwin", "arm64")).toThrow("does not match");
    expect(() => nativePlan("i686-pc-windows-msvc", "win32", "ia32")).toThrow("does not match");
  });
  test("cannot enable signing, notarization, publishing or foreign targets through CLI flags", () => {
    const config = unsignedConfig(nativePlan("aarch64-apple-darwin", "darwin", "arm64"));
    expect(config.mac).toEqual({ identity: null, notarize: false });
    expect(config.dmg.sign).toBe(false);
    expect(config.win.signExecutable).toBe(false);
    expect(config.forceCodeSigning).toBe(false);
    expect(config.publish).toBeNull();
    expect(packageMode([])).toBe("dir");
    expect(packageMode(["--dist", "--dry-run"])).toBe("dist");
    for (const flag of ["--publish=always", "--mac", "--x64", "--config.mac.identity=Developer ID"]) {
      expect(() => packageMode([flag])).toThrow("Usage");
    }
    expect(() => packageMode(["--dir", "--dist"])).toThrow("Usage");
    expect(localEnvironment({ PATH: "/bin", CSC_NAME: "private", CSC_LINK: "private", APPLE_ID: "private", WIN_CSC_LINK: "private", GH_TOKEN: "private", GITHUB_TOKEN: "private", AZURE_CLIENT_SECRET: "private", CSC_IDENTITY_AUTO_DISCOVERY: "true", csc_link: "private" }))
      .toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  });
  test("keeps the bootstrap, worker chunks, and MIT license in package inputs", () => {
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    expect(pkg.main).toBe("dist/main.mjs");
    expect(pkg.build.files).toContain("dist/**/*");
    expect(pkg.license).toBe("MIT");
    expect(pkg.build.extraResources).toContainEqual({ from: "../LICENSE", to: "LICENSE" });
    expect(pkg.build.linux.executableArgs).toEqual(["%f"]);
    expect(pkg.build.linux.syncDesktopName).toBe(true);
    expect(pkg.name).toBe("simplemd");
    expect(pkg.productName).toBe("SimpleMD");
    expect(pkg.build.productName).toBe("SimpleMD");
    expect(pkg.build.appId).toBe("com.jonathanreed.simplemd");
    expect(pkg.build.nsis.shortcutName).toBe("SimpleMD");
    expect(pkg.build.linux.executableName).toBe("simplemd");
    expect(pkg.desktopName).toBe("simplemd.desktop");
  });
  test("keeps JIT support without Apple Events permission", () => {
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    const main = readFileSync(path.join(appDir, pkg.build.mac.entitlements), "utf8");
    const helpers = readFileSync(path.join(appDir, pkg.build.mac.entitlementsInherit), "utf8");
    expect(main).toContain("com.apple.security.cs.allow-jit");
    expect(main).not.toContain("com.apple.security.automation.apple-events");
    expect(pkg.build.mac.extendInfo.NSAppleEventsUsageDescription).toBeUndefined();
    expect(helpers).toContain("com.apple.security.cs.allow-jit");
    expect(helpers).not.toContain("com.apple.security.automation.apple-events");
    expect(main + helpers).not.toContain("com.apple.security.cs.allow-unsigned-executable-memory");
  });
  test("installed electron-builder accepts the merged unsigned configuration", async () => {
    const { getConfig, validateConfiguration } = await import("app-builder-lib/out/util/config/config.js");
    const { DebugLogger } = await import("builder-util");
    const { createTargets, Platform, Arch } = await import("electron-builder");
    const plan = nativePlan("aarch64-apple-darwin", "darwin", "arm64");
    const config = await getConfig(appDir, null, unsignedConfig(plan));
    await validateConfiguration(config, new DebugLogger(false));
    expect(config.extraResources).toEqual([
      { from: "../LICENSE", to: "LICENSE" },
      ...unsignedConfig(plan).extraResources,
    ]);
    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
    expect(config.dmg.sign).toBe(false);
    expect(config.win.signExecutable).toBe(false);
    expect(config.publish).toBeNull();
    expect(createTargets([Platform.MAC], "dir", "arm64").get(Platform.MAC).get(Arch.arm64)).toEqual(["dir"]);
    expect(createTargets([Platform.WINDOWS], null, "x64").get(Platform.WINDOWS).has(Arch.x64)).toBe(true);
    expect(createTargets([Platform.LINUX], null, "x64").get(Platform.LINUX).has(Arch.x64)).toBe(true);
  });
});

describe("Linux launch integration", () => {
  test("prints a single-file association and escapes desktop Exec metacharacters", () => {
    const entry = desktopEntry('/home/test/My "notes" $cash` %app\\.AppImage');
    expect(entry).toContain('Exec="/home/test/My \\\\"notes\\\\" \\\\$cash\\\\` %%app\\\\\\\\.AppImage" %f\n');
    expect(entry).toContain("MimeType=text/markdown;text/x-markdown;");
    expect(entry).toContain("Name=SimpleMD\n");
    expect(entry).toContain("StartupWMClass=simplemd\n");
    for (const invalid of [undefined, "relative.AppImage", "/tmp/app\nExec=bad", "/tmp/a\r", "/tmp/a\t", "/tmp/a\0", "/tmp/a\x7f"]) {
      expect(() => desktopEntry(invalid)).toThrow("absolute Linux");
    }
  });
  test.skipIf(process.platform === "win32")("portable wrapper preserves file arguments and clears Electron's Node mode", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "smd-launcher-"));
    try {
      const fake = path.join(dir, "fake app");
      writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "${ELECTRON_RUN_AS_NODE-unset}" "$@"\n');
      chmodSync(fake, 0o755);
      const files = ["note with spaces.md", "note#1.md", "quote'$.md"];
      const result = spawnSync("sh", [path.join(appDir, "integrations/linux/simple-md-open"), ...files], { encoding: "utf8", env: { ...process.env, SIMPLE_MD_EXECUTABLE: fake, ELECTRON_RUN_AS_NODE: "1" } });
      expect(result.status).toBe(0);
      expect(result.stdout.trimEnd().split("\n")).toEqual(["unset", ...files]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the package file filter excludes the browser render bundle from app.asar", async () => {
  const fs = await import("node:fs/promises");
  const { FileMatcher } = await import("app-builder-lib/out/fileMatcher.js");
  const { createPackageFromFiles, listPackage } = await import("@electron/asar");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-package-filter-"));
  try {
    const source = path.join(dir, "app");
    await fs.mkdir(path.join(source, "dist"), { recursive: true });
    const names = ["dist/main.mjs", "dist/render-worker.mjs", "dist/render-core.js", "package.json"];
    for (const name of names) await fs.writeFile(path.join(source, name), "fixture");
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    const filter = new FileMatcher(source, path.join(dir, "stage"), value => value, pkg.build.files).createFilter();
    const files = [];
    for (const name of names) {
      const file = path.join(source, name);
      if (filter(file, await fs.stat(file))) files.push(file);
    }
    const archive = path.join(dir, "app.asar");
    await createPackageFromFiles(source, archive, files);
    const packed = listPackage(archive);
    expect(packed).toContain("/dist/render-worker.mjs");
    expect(packed).not.toContain("/dist/render-core.js");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

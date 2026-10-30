import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appDir, nativePlan, currentNativePlan } from "./native.mjs";
import { localEnvironment, packageMode, unsignedConfig, packagingConfig } from "./local-pack.mjs";
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
      expect(plan.args).not.toContain("--features");
      expect(plan.cliBinary).not.toContain("cli-tests");
      expect(plan.args[plan.args.indexOf("--target") + 1]).toBe(host);
      expect(plan.args[plan.args.indexOf("--target-dir") + 1]).toBe(path.join(appDir, "native", "target"));
      expect(plan.binary).toContain(path.join(host, "release", plan.executable));
      expect(plan.executable.endsWith(".exe")).toBe(platform === "win32");
      expect(plan.executable).toBe(platform === "win32" ? "simplemd-helper.exe" : "simplemd-helper");
      expect(unsignedConfig(plan).extraResources[1]).toEqual({ from: plan.cliBinary, to: `native/${plan.cliExecutable}` });
      expect(plan.cliExecutable).toBe(platform === "win32" ? "simplemd.exe" : "simplemd");
      expect(unsignedConfig(plan).extraResources[0]).toEqual({ from: plan.binary, to: `native/${plan.executable}` });
    });
  }
  test("rejects mismatched toolchains and unsupported architectures", () => {
    expect(() => nativePlan("x86_64-apple-darwin", "darwin", "arm64")).toThrow("does not match");
    expect(() => nativePlan("i686-pc-windows-msvc", "win32", "ia32")).toThrow("does not match");
  });
  test("requires explicit signing identity and rejects publishing or foreign CLI targets", () => {
    const config = unsignedConfig(nativePlan("aarch64-apple-darwin", "darwin", "arm64"));
    expect(config.mac).toEqual({ identity: "-", notarize: false });
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
      .toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_FOR_PULL_REQUEST: "true" });
    expect(localEnvironment({ CSC_FOR_PULL_REQUEST: "true" }, "Developer ID Application: Test").CSC_FOR_PULL_REQUEST).toBeUndefined();
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
    expect(pkg.build.linux.executableName).toBe("simplemd-app");
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
      { from: "../THIRD_PARTY_NOTICES", to: "THIRD_PARTY_NOTICES" },
      ...unsignedConfig(plan).extraResources,
    ]);
    expect(config.mac.identity).toBe("-");
    expect(config.mac.notarize).toBe(false);
    expect(config.dmg.sign).toBe(false);
    expect(config.win.signExecutable).toBe(false);
    expect(config.publish).toBeNull();
    expect(createTargets([Platform.MAC], "dir", "arm64").get(Platform.MAC).get(Arch.arm64)).toEqual(["dir"]);
    expect(createTargets([Platform.WINDOWS], null, "x64").get(Platform.WINDOWS).has(Arch.x64)).toBe(true);
    expect(createTargets([Platform.LINUX], null, "x64").get(Platform.LINUX).has(Arch.x64)).toBe(true);
  });
});

test.skipIf(process.platform !== "darwin")("PR packaging permits only credential-free ad-hoc signing", async () => {
  const { isSignAllowed } = await import("app-builder-lib/out/codeSign/macCodeSign.js");
  const saved = { ...process.env };
  try {
    delete process.env.CSC_FOR_PULL_REQUEST;
    process.env.GITHUB_BASE_REF = "main";
    expect(isSignAllowed(false)).toBe(false);
    Object.assign(process.env, localEnvironment(process.env));
    expect(isSignAllowed(false)).toBe(true);
    const clean = localEnvironment(process.env, "Developer ID Application: Test");
    delete process.env.CSC_FOR_PULL_REQUEST;
    Object.assign(process.env, clean);
    expect(isSignAllowed(false)).toBe(false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
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
    const packed = listPackage(archive).map(name => name.split(path.sep).join("/"));
    expect(packed).toContain("/dist/render-worker.mjs");
    expect(packed).not.toContain("/dist/render-core.js");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

describe("Quick Look packaging", () => {
  test("uses explicit Developer ID or ad-hoc signing without notarization", () => {
    const plan = nativePlan("aarch64-apple-darwin", "darwin", "arm64");
    expect(packagingConfig(plan).mac.identity).toBe("-");
    const signed = packagingConfig(plan, "Developer ID Application: Jonathan Reed (AJ9VWBRNZN)");
    expect(signed.mac.identity).toBe("Jonathan Reed (AJ9VWBRNZN)");
    expect(signed.forceCodeSigning).toBe(true);
    expect(signed.mac.notarize).toBe(false);
    expect(() => packagingConfig(plan, "Apple Development: somebody")).toThrow("Developer ID");
  });
  test("builds extensions before outer signing and excludes PlugIns from Electron signing", () => {
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    expect(pkg.build.afterPack).toBe("build/quicklook.mjs");
    expect(pkg.build.afterSign).toBe("build/quicklook-verify.mjs");
    expect(pkg.build.mac.signIgnore).toContain("/Contents/PlugIns/");
    expect(pkg.build.mac.minimumSystemVersion).toBe("13.0");
    const mdx = pkg.build.mac.extendInfo.UTExportedTypeDeclarations.find(type => type.UTTypeIdentifier === "com.jonathanreed.simplemd.mdx");
    expect(mdx.UTTypeTagSpecification["public.filename-extension"]).toContain("mdx");
    const markdown = pkg.build.mac.extendInfo.UTImportedTypeDeclarations.find(type => type.UTTypeIdentifier === "net.daringfireball.markdown");
    expect(markdown.UTTypeConformsTo).toEqual(["public.plain-text"]);
    expect(markdown.UTTypeTagSpecification["public.filename-extension"]).toEqual(["md", "markdown", "mdown", "mkd"]);
  });
  test.skipIf(process.platform !== "darwin")("declares only Markdown and MDX, and App Sandbox only", async () => {
    const { readPlist } = await import("./quicklook-verify.mjs");
    const entitlements = readPlist(path.join(appDir, "native/quicklook/extension.entitlements"));
    expect(entitlements).toEqual({ "com.apple.security.app-sandbox": true });
    for (const kind of ["preview", "thumbnail"]) {
      const info = readPlist(path.join(appDir, `native/quicklook/${kind}/Info.plist`));
      expect(info.CFBundleIdentifier).toBe(`com.jonathanreed.simplemd.${kind}`);
      expect(info.LSMinimumSystemVersion).toBe("13.0");
      const attributes = info.NSExtension.NSExtensionAttributes;
      expect(attributes.QLSupportedContentTypes).toEqual([
        "net.daringfireball.markdown", "public.markdown", "com.jonathanreed.simplemd.mdx", "com.fluxmarkdown.mdx",
      ]);
      if (kind === "preview") expect(attributes.QLIsDataBasedPreview).toBe(true);
    }
  });
  test.skipIf(!process.env.SIMPLEMD_PACKAGED_APP)("verifies the exact packaged layout, signatures and entitlements", async () => {
    const { verifyQuickLook } = await import("./quicklook-verify.mjs");
    verifyQuickLook(process.env.SIMPLEMD_PACKAGED_APP);
  });
});

test("local build verifies its final app even when the builder skips afterSign", async () => {
  const { buildAndVerify } = await import('./local-pack.mjs');
  const events = [];
  const app = '/tmp/final/SimpleMD.app';
  await buildAndVerify(async () => { events.push('build'); }, {}, () => app,
    target => { expect(target).toBe(app); events.push('verify'); });
  expect(events).toEqual(['build', 'verify']);
  await expect(buildAndVerify(async () => {}, {}, () => app, () => { throw Error('unsigned'); })).rejects.toThrow('unsigned');
});

test("Quick Look identity comes from the explicit full identity", async () => {
  const { quickLookIdentity } = await import('./quicklook.mjs');
  expect(quickLookIdentity({})).toBe('-');
  expect(quickLookIdentity({ SIMPLEMD_SIGN_IDENTITY: 'Developer ID Application: Jonathan Reed (AJ9VWBRNZN)' }))
    .toBe('Developer ID Application: Jonathan Reed (AJ9VWBRNZN)');
  expect(() => quickLookIdentity({ SIMPLEMD_SIGN_IDENTITY: 'Jonathan Reed' })).toThrow('Developer ID');
});


test("Linux CLI hooks retain builder launcher and sandbox setup and clean their temporary scripts", async () => {
  const { withLinuxCliHooks } = await import("./linux-cli.mjs");
  let generated;
  await withLinuxCliHooks({}, async config => {
    generated = config.deb.afterInstall;
    const install = readFileSync(config.deb.afterInstall, "utf8");
    const remove = readFileSync(config.deb.afterRemove, "utf8");
    expect(install).toContain("update-alternatives --install");
    expect(install).toContain("chrome-sandbox");
    expect(install).toContain("apparmor_parser");
    expect(install).toContain("resources/native/simplemd");
    expect(remove).toContain("update-alternatives --remove");
    expect(remove).toContain("resources/native/simplemd");
  });
  const { existsSync } = await import("node:fs");
  expect(existsSync(generated)).toBe(false);
});

test("release CLI contains no test-only environment overrides", () => {
  const binary = readFileSync(currentNativePlan().cliBinary);
  for (const name of ["SMD_CLI_RUNTIME", "SMD_CLI_APP", "SMD_CLI_APP_ROOT"]) expect(binary.includes(Buffer.from(name))).toBe(false);
});


describe("Windows preview packaging", () => {
  test("ships the embedded renderer DLL and per-user scripts with NSIS", () => {
    const plan = nativePlan("x86_64-pc-windows-msvc", "win32", "x64");
    const resources = unsignedConfig(plan).extraResources;
    expect(resources).toContainEqual({
      from: path.join(appDir, "native/windows-preview/target", plan.host, "release/simplemd_windows_preview.dll"),
      to: "native/preview/simplemd_windows_preview.dll",
    });
    for (const name of ["install.ps1", "uninstall.ps1", "paths.ps1"]) {
      expect(resources).toContainEqual({ from: path.join(appDir, "native/windows-preview", name), to: `native/preview/${name}` });
    }
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    expect(pkg.build.nsis.perMachine).toBe(false);
    expect(pkg.build.nsis.allowElevation).toBe(false);
    expect(pkg.build.nsis.runAfterFinish).toBe(false);
    expect(pkg.build.nsis.include).toBe("build/cli-installer.nsh");
    const install = readFileSync(path.join(appDir, "native/windows-preview/install.ps1"), "utf8");
    for (const ext of pkg.build.fileAssociations.flatMap(item => item.ext)) expect(install).toContain(`'.${ext}'`);
  });
});

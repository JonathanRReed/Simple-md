import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDir, currentNativePlan, buildNative, run } from "./native.mjs";
import { localEnvironment } from "./local-pack.mjs";
import afterPack, { packagedApp } from "./quicklook.mjs";
import { verifyQuickLook } from "./quicklook-verify.mjs";
import { releaseConfig, releaseVersion, repository } from "./release-config.mjs";
import { refreshUpdateMetadata, writeChecksums } from "./release-metadata.mjs";

export function macReleasePlan({ version, expected, dirty, platform, arch, identity, keychainProfile = "simplemd-notary" }) {
  releaseVersion(expected);
  if (version !== expected) throw new Error(`Version mismatch: package is ${version}, requested ${expected}.`);
  if (dirty.trim()) throw new Error("Release requires a clean git tree, including untracked files.");
  if (platform !== "darwin" || arch !== "arm64") throw new Error("Run on an Apple Silicon Mac. Intel Macs are not supported.");
  if (identity && (!identity.startsWith("Developer ID Application: ") || !identity.endsWith("(AJ9VWBRNZN)"))) throw new Error("Use a Developer ID Application identity for team AJ9VWBRNZN.");
  return {
    version, arch, identity: identity || "Developer ID Application: <owner identity> (AJ9VWBRNZN)",
    keychainProfile, team: "AJ9VWBRNZN",
    output: path.join(appDir, "release", `mac-${version}-${arch}`),
    steps: ["Build app, Rust helper and CLI", "Sign Quick Look extensions and app with Developer ID",
      `Notarize app ZIP with --keychain-profile ${keychainProfile} --wait`, "Staple app and verify with spctl and stapler validate",
      "Create DMG and ZIP of stapled app plus latest-mac.yml", "Notarize and staple DMG, verify, refresh hashes and write SHA256SUMS"],
    upload: `gh release upload v${version} --repo ${repository} <output>/*.dmg <output>/*.zip <output>/*.blockmap <output>/latest-mac.yml <output>/SHA256SUMS-mac-${arch}`,
  };
}
export async function releaseMac(args) {
  if (args.some((arg, i) => arg !== "--dry-run" && arg !== "--version" && args[i - 1] !== "--version") || args.filter(arg => arg === "--version").length !== 1) {
    throw new Error("Usage: bun run release:mac --version X.Y.Z [--dry-run]");
  }
  const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: appDir, encoding: "utf8" });
  const plan = macReleasePlan({ version: pkg.version, expected: args[args.indexOf("--version") + 1], dirty,
    platform: process.platform, arch: process.arch, identity: process.env.SIMPLEMD_SIGN_IDENTITY,
    keychainProfile: process.env.SIMPLEMD_NOTARY_PROFILE || undefined });
  if (!pkg.build.mac.target.includes("zip") || !pkg.build.mac.target.includes("dmg") || !pkg.build.mac.hardenedRuntime) throw new Error("Release needs DMG, ZIP and hardened runtime.");
  const config = { ...releaseConfig(currentNativePlan(), plan.output), forceCodeSigning: true,
    mac: { identity: plan.identity.slice("Developer ID Application: ".length), notarize: false }, dmg: { sign: true, writeUpdateInfo: false } };
  const { getConfig, validateConfiguration } = await import("app-builder-lib/out/util/config/config.js");
  const { DebugLogger } = await import("builder-util");
  await validateConfiguration(await getConfig(appDir, null, config), new DebugLogger(false));
  console.log(JSON.stringify({ ...plan, config, publish: "never" }, null, 2));
  if (args.includes("--dry-run")) return;
  if (!process.env.SIMPLEMD_SIGN_IDENTITY) throw new Error("Set SIMPLEMD_SIGN_IDENTITY to the full Developer ID Application identity.");
  if (existsSync(plan.output)) throw new Error(`Output already exists: ${plan.output}. Move it aside before retrying.`);
  const clean = localEnvironment(process.env);
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
  Object.assign(process.env, clean, { CARGO_BUILD_JOBS: "4" });
  run(process.execPath, ["run", "build"]);
  buildNative(currentNativePlan());
  const notarize = file => run("xcrun", ["notarytool", "submit", file, "--keychain-profile", plan.keychainProfile, "--wait"]);
  const staple = file => { run("xcrun", ["stapler", "staple", file]); run("xcrun", ["stapler", "validate", file]); };
  config.afterPack = afterPack;
  config.afterSign = async context => {
    const app = packagedApp(context);
    verifyQuickLook(app);
    run("codesign", ["--verify", "--strict", "-R", 'anchor apple generic and certificate leaf[subject.OU] = "AJ9VWBRNZN"', app]);
    const scratch = mkdtempSync(path.join(os.tmpdir(), "simplemd-notary-"));
    try {
      const archive = path.join(scratch, "SimpleMD.zip");
      run("ditto", ["-c", "-k", "--keepParent", app, archive]);
      notarize(archive);
      staple(app);
      run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  };
  const { build, createTargets, Platform } = await import("electron-builder");
  await build({ projectDir: appDir, targets: createTargets([Platform.MAC], ["dmg", "zip"], process.arch), config, publish: "never" });
  for (const name of readdirSync(plan.output).filter(name => name.endsWith(".dmg"))) {
    const dmg = path.join(plan.output, name);
    notarize(dmg); staple(dmg);
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg]);
  }
  await refreshUpdateMetadata(plan.output);
  await writeChecksums(plan.output, `SHA256SUMS-mac-${plan.arch}`, { includeMetadata: false });
  console.log(plan.upload.replaceAll("<output>", plan.output));
}
if (import.meta.main) await releaseMac(process.argv.slice(2));

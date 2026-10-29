import { appDir, buildNative, currentNativePlan, run } from "./native.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

export function unsignedConfig(plan) {
  return {
    forceCodeSigning: false,
    publish: null,
    extraResources: [
      { from: plan.binary, to: `native/${plan.executable}` },
    ],
    mac: { identity: "-", notarize: false },
    dmg: { sign: false },
    win: { signExecutable: false },
  };
}

export function packagingConfig(plan, identity) {
  const config = unsignedConfig(plan);
  if (identity) {
    if (!identity.startsWith("Developer ID Application: ")) throw new Error("Supply a Developer ID Application identity.");
    config.mac.identity = identity.slice("Developer ID Application: ".length);
    config.forceCodeSigning = true;
  }
  return config;
}

export function localEnvironment(env) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:CSC_|WIN_CSC_|APPLE_|AZURE_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(key))),
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
}

export function packageMode(args) {
  const allowed = new Set(["--dir", "--dist", "--dry-run"]);
  if (args.some((arg) => !allowed.has(arg)) || (args.includes("--dir") && args.includes("--dist"))) {
    throw new Error("Usage: bun build/local-pack.mjs [--dir | --dist] [--dry-run]. Only the current platform and architecture are supported.");
  }
  return args.includes("--dist") ? "dist" : "dir";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = packageMode(args);
  const plan = currentNativePlan();
  const config = packagingConfig(plan, process.env.SIMPLEMD_SIGN_IDENTITY);
  if (args.includes("--dry-run")) {
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    console.log(JSON.stringify({ productName: pkg.build.productName, platform: process.platform, arch: process.arch, mode, native: plan, config, publish: "never" }, null, 2));
  } else {
    const clean = localEnvironment(process.env);
    for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
    Object.assign(process.env, clean);
    run(process.execPath, ["run", "build"]);
    buildNative(plan);
    const { build, createTargets, Platform } = await import("electron-builder");
    await build({
      projectDir: appDir,
      targets: createTargets([Platform.current()], mode === "dir" ? "dir" : null, process.arch),
      config,
      publish: "never",
    });
  }
}

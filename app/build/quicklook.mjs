import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appDir, run } from "./native.mjs";

export function readPlist(file) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

export const extensions = ["SimpleMDQLPreview.appex", "SimpleMDQLThumbnail.appex"];

export function packagedApp(context) {
  return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
}

export function quickLookIdentity(env = process.env) {
  const identity = env.SIMPLEMD_SIGN_IDENTITY || "-";
  if (identity !== "-" && !identity.startsWith("Developer ID Application: ")) throw new Error("Supply a full Developer ID Application identity.");
  return identity;
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "simplemd-quicklook-"));
  try {
    const output = path.join(scratch, "extensions");
    const identity = quickLookIdentity();
    const host = readPlist(path.join(packagedApp(context), "Contents/Info.plist"));
    run("bash", [path.join(appDir, "native/quicklook/build-extensions.sh"), output, identity,
      host.CFBundleShortVersionString, host.CFBundleVersion]);
    const plugins = path.join(packagedApp(context), "Contents/PlugIns");
    mkdirSync(plugins, { recursive: true });
    for (const extension of extensions) cpSync(path.join(output, extension), path.join(plugins, extension), { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

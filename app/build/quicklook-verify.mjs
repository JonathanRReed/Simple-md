import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { extensions, packagedApp } from "./quicklook.mjs";

export function readPlist(file) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

export function verifyQuickLook(app) {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
  for (const extension of extensions) {
    const bundle = path.join(app, "Contents/PlugIns", extension);
    const info = readPlist(path.join(bundle, "Contents/Info.plist"));
    const kind = extension === extensions[0] ? "preview" : "thumbnail";
    if (info.CFBundleIdentifier !== `com.jonathanreed.simplemd.${kind}`) throw new Error(`Unexpected extension ID in ${bundle}`);
    const binary = path.join(bundle, "Contents/MacOS", info.CFBundleExecutable);
    const archs = execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" }).trim().split(/\s+/).sort();
    if (archs.join(" ") !== "arm64 x86_64") throw new Error(`Extension is not universal: ${bundle}`);
    const signed = execFileSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", bundle], { encoding: "utf8" });
    const entitlements = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: signed, encoding: "utf8" }));
    if (JSON.stringify(entitlements) !== JSON.stringify({ "com.apple.security.app-sandbox": true })) {
      throw new Error(`Quick Look must have App Sandbox only: ${bundle}`);
    }
    if (kind === "preview" && (!info.NSExtension.NSExtensionAttributes.QLIsDataBasedPreview ||
        !existsSync(path.join(bundle, "Contents/Resources/render-core.js")))) throw new Error("Missing data preview or render bundle");
  }
}

export default async function afterSign(context) {
  if (context.electronPlatformName === "darwin") verifyQuickLook(packagedApp(context));
}

if (import.meta.main) verifyQuickLook(process.argv[2]);

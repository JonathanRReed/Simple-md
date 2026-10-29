import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { extensions, packagedApp } from "./quicklook.mjs";

export function readPlist(file) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

function signature(bundle) {
  const result = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", bundle], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stderr;
}

export function verifyQuickLook(app) {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
  const outer = signature(app);
  const authority = outer.match(/^Authority=(Developer ID Application: .+)$/m)?.[1];
  for (const extension of extensions) {
    const bundle = path.join(app, "Contents/PlugIns", extension);
    const info = readPlist(path.join(bundle, "Contents/Info.plist"));
    const kind = extension === extensions[0] ? "preview" : "thumbnail";
    if (info.CFBundleIdentifier !== `com.jonathanreed.simplemd.${kind}`) throw new Error(`Unexpected extension ID in ${bundle}`);
    if (info.LSMinimumSystemVersion !== "13.0") throw new Error(`Unexpected deployment target: ${bundle}`);
    const types = info.NSExtension.NSExtensionAttributes.QLSupportedContentTypes;
    if (JSON.stringify(types) !== JSON.stringify([
      "net.daringfireball.markdown", "public.markdown", "com.jonathanreed.simplemd.mdx", "com.fluxmarkdown.mdx",
    ])) throw new Error(`Unexpected supported types: ${bundle}`);
    const signing = signature(bundle);
    if (!/flags=.*\([^)]*runtime/.test(signing)) throw new Error(`Missing hardened runtime: ${bundle}`);
    if (authority) {
      if (!signing.includes(`Authority=${authority}\n`) || !/^Timestamp=.+$/m.test(signing)) {
        throw new Error(`Extension identity or secure timestamp differs: ${bundle}`);
      }
    } else if (!outer.includes("Signature=adhoc") || !signing.includes("Signature=adhoc")) {
      throw new Error(`Expected matching ad-hoc signatures: ${bundle}`);
    }
    const binary = path.join(bundle, "Contents/MacOS", info.CFBundleExecutable);
    const archs = execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" }).trim().split(/\s+/).sort();
    if (archs.join(" ") !== "arm64 x86_64") throw new Error(`Extension is not universal: ${bundle}`);
    const build = execFileSync("/usr/bin/xcrun", ["vtool", "-show-build", binary], { encoding: "utf8" });
    if ((build.match(/minos 13.0/g) ?? []).length !== 2) throw new Error(`Unexpected Mach-O deployment targets: ${bundle}`);
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

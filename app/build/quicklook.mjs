import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDir, run } from "./native.mjs";

export const extensions = ["SimpleMDQLPreview.appex", "SimpleMDQLThumbnail.appex"];

export function packagedApp(context) {
  return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "simplemd-quicklook-"));
  try {
    const output = path.join(scratch, "extensions");
    const qualifier = context.packager.platformSpecificBuildOptions.identity;
    const identity = !qualifier || qualifier === "-" ? "-" : `Developer ID Application: ${qualifier}`;
    run("bash", [path.join(appDir, "native/quicklook/build-extensions.sh"), output, identity]);
    const plugins = path.join(packagedApp(context), "Contents/PlugIns");
    mkdirSync(plugins, { recursive: true });
    for (const extension of extensions) cpSync(path.join(output, extension), path.join(plugins, extension), { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

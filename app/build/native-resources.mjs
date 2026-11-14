import path from "node:path";
import { appDir } from "./native.mjs";

export function nativeResources(plan) {
  return [
    { from: plan.binary, to: `native/${plan.executable}` },
    { from: plan.cliBinary, to: `native/${plan.cliExecutable}` },
    ...(plan.platform === "win32" ? [
      { from: path.join(appDir, "native/windows-preview/target", plan.host, "release/simplemd_windows_preview.dll"), to: "native/preview/simplemd_windows_preview.dll" },
      ...["install.ps1", "uninstall.ps1", "paths.ps1"].map(name => ({ from: path.join(appDir, "native/windows-preview", name), to: `native/preview/${name}` })),
    ] : []),
  ];
}

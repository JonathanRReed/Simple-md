import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
let cached: Promise<{ fonts: string[]; fontError?: string }> | undefined;
export function systemFonts(): Promise<{ fonts: string[]; fontError?: string }> {
  return cached ??= listFonts().catch(error => {
    console.error("simplemd: cannot list installed fonts", error);
    return { fonts: ["system-ui", "serif", "sans-serif", "ui-monospace"], fontError: "Installed fonts could not be listed. System defaults remain available." };
  });
}
async function listFonts(): Promise<{ fonts: string[] }> {
  let names: string[];
  const options = { encoding: "utf8" as const, timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
  if (process.platform === "darwin") {
    const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies).join("\\n")'], options);
    names = stdout.split(/\r?\n/);
  } else if (process.platform === "win32") {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name"], options);
    names = stdout.split(/\r?\n/);
  } else {
    const { stdout } = await run("fc-list", ["--format=%{family}\\n"], options);
    names = stdout.split(/[\r\n,]/);
  }
  return { fonts: [...new Set(["system-ui", "serif", "sans-serif", "ui-monospace", ...names.map(name => name.trim()).filter(Boolean)])].sort((a, b) => a.localeCompare(b)) };
}

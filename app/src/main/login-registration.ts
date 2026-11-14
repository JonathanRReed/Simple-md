import fs from "node:fs";
import path from "node:path";
export function loginEnabled(platform: NodeJS.Platform, state: { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean; status?: string }): boolean {
  if (platform === "darwin") return state.openAtLogin && (state.status === undefined || state.status === "enabled");
  if (platform === "win32") return state.executableWillLaunchAtLogin === true;
  return state.openAtLogin;
}
export function linuxLoginFile(home: string): string { return path.join(home, ".config/autostart/simplemd.desktop"); }
export function readLinuxLogin(home: string, executable: string): boolean {
  try {
    const text = fs.readFileSync(linuxLoginFile(home), "utf8");
    return text.includes(`Exec="${executable}" --background`) && !/^Hidden=true\s*$/m.test(text) && !/^X-GNOME-Autostart-enabled=false\s*$/m.test(text);
  } catch { return false; }
}

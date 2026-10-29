import { execFile } from "node:child_process";

const FRONT_CHECK = `
tell application "System Events" to set frontApp to name of first application process whose frontmost is true
if frontApp is not "Finder" then return ""
`;

const FINDER_SCRIPT = `
tell application "Finder"
  set out to ""
  repeat with a in (get selection as alias list)
    set out to out & POSIX path of a & linefeed
  end repeat
  return out
end tell`;

// Matches the foreground window against Explorer's open windows, then lists its selected items.
const EXPLORER_SCRIPT = `
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
$fg = [W.U]::GetForegroundWindow().ToInt64()
$selected = @()
$shell = New-Object -ComObject Shell.Application
foreach ($w in $shell.Windows()) {
  if ($w.HWND -eq $fg) { $selected = @($w.Document.SelectedItems() | ForEach-Object { $_.Path }) }
}
if ([W.U]::GetForegroundWindow().ToInt64() -eq $fg) { $selected }`;

function run(cmd: string, args: string[], timeout = 2000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

// Paths selected in the frontmost file manager. The key hook only fires when one is frontmost, so it
// passes verifyFrontmost=false; the global shortcut can fire anywhere and must check. Linux has no portable equivalent.
export async function getFileManagerSelection(verifyFrontmost = true): Promise<string[]> {
  let out = "";
  if (process.platform === "darwin") {
    out = await run("osascript", ["-e", (verifyFrontmost ? FRONT_CHECK : "") + FINDER_SCRIPT]);
  } else if (process.platform === "win32") {
    out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", EXPLORER_SCRIPT]);
  }
  return out.split(/\r?\n/).filter(Boolean);
}

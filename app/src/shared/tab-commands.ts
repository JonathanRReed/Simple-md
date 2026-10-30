import type { Command, Settings } from "./types.js";

export function tabCommands(settings: Settings, path: string | null): { label: string; command: Command }[] {
  const pinned = path !== null && settings.pinnedPaths.includes(path);
  return [
    { label: settings.zenMode ? "Leave Zen Mode" : "Enter Zen Mode", command: "toggle-zen" },
    ...(path ? [{ label: pinned ? "Unpin Tab" : "Pin Tab", command: "toggle-pin-tab" as const }] : []),
    ...(pinned ? [{ label: "Close Pinned Tab", command: "close-pinned-tab" as const }] : []),
  ];
}

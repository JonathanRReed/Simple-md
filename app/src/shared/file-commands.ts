import type { Command, Settings } from "./types.js";
export function fileCommands(settings: Settings, path: string | null): { label: string; command: Command }[] {
  return [
    { label: "Reopen Closed Tab", command: "reopen-closed-tab" },
    { label: "Close Other Tabs", command: "close-other-tabs" },
    { label: settings.tabStyle === "sidebar" ? "Close Tabs Below" : "Close Tabs to the Right", command: "close-tabs-below" },
    ...(path ? [{ label: "Copy Path", command: "copy-path" as const }, { label: "Rename or Move…", command: "rename-move" as const }] : []),
    { label: "Duplicate…", command: "duplicate-file" },
    { label: "Make SimpleMD the Default Markdown App…", command: "default-markdown-app" },
  ];
}

import type { JumpListCategory, JumpListItem } from "electron";

export interface RecentOS {
  addRecentDocument(file: string): void;
  clearRecentDocuments(): void;
  getRecentDocuments(): string[];
  getJumpListSettings(): { removedItems: JumpListItem[] };
  setJumpList(categories: JumpListCategory[]): unknown;
}

export function isolatedRecents(): RecentOS {
  let files: string[] = [];
  return {
    addRecentDocument: file => { files = [file, ...files.filter(p => p !== file)]; },
    clearRecentDocuments: () => { files = []; },
    getRecentDocuments: () => [...files],
    getJumpListSettings: () => ({ removedItems: [] }),
    setJumpList: () => "ok",
  };
}

export function recentFiles(os: RecentOS, platform: string, fallback: string[]): string[] {
  if (platform !== "darwin" && platform !== "win32") return fallback;
  const removed = platform === "win32" ? new Set(os.getJumpListSettings().removedItems.flatMap(item => item.path ? [item.path.toLowerCase()] : [])) : new Set<string>();
  return os.getRecentDocuments().filter(file => !removed.has(file.toLowerCase())).slice(0, 12);
}

export function jumpList(executable: string, appPath?: string): JumpListCategory[] {
  return [
    { type: "recent" },
    { type: "tasks", items: [{ type: "task", title: "New Window", description: "Open a new SimpleMD window", path: executable,
      args: appPath ? `"${appPath}" --new-window` : "--new-window", iconPath: executable, iconIndex: 0 }] },
  ];
}

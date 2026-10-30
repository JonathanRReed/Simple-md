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

export function clearNativeRecents(os: RecentOS, platform: string): void {
  // Electron's Windows API clears shared shell history. Rebuild our custom category there.
  if (platform === "darwin") os.clearRecentDocuments();
}

export function recentFiles(os: RecentOS, platform: string, fallback: string[]): string[] {
  if (platform !== "darwin" && platform !== "win32") return fallback;
  const removed = platform === "win32" ? new Set(os.getJumpListSettings().removedItems.flatMap(item => item.path ? [item.path.toLowerCase()] : [])) : new Set<string>();
  const native = os.getRecentDocuments();
  if (platform === "win32") {
    const present = new Set(native.map(file => file.toLowerCase()));
    return fallback.filter(file => present.has(file.toLowerCase()) && !removed.has(file.toLowerCase())).slice(0, 12);
  }
  return native.slice(0, 12);
}

export function jumpList(executable: string, appPath?: string, files: string[] = []): JumpListCategory[] {
  return [
    ...(files.length ? [{ name: "Recent", items: files.map(file => ({ type: "file", path: file } satisfies JumpListItem)) }] : []),
    { type: "tasks", items: [{ type: "task", title: "New Window", description: "Open a new SimpleMD window", path: executable,
      args: appPath ? `"${appPath}" --new-window` : "--new-window", iconPath: executable, iconIndex: 0 }] },
  ];
}

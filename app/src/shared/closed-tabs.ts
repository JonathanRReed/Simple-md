import type { DocumentId } from "./types.js";

/** Paths only. Discarded text and editor state never enter this session-only stack. */
export class ClosedTabs {
  private paths: string[] = [];
  add(file: string | null): void { if (file) this.paths.push(file); }
  take(): string | undefined { return this.paths.pop(); }
  get size(): number { return this.paths.length; }
}
export function tabsToClose(tabs: readonly DocumentId[], pinned: readonly DocumentId[], target: DocumentId, below: boolean): DocumentId[] {
  const at = tabs.indexOf(target);
  if (at < 0) return [];
  const protectedTabs = new Set(pinned);
  return tabs.filter((id, index) => id !== target && !protectedTabs.has(id) && (!below || index > at));
}
export async function closeTabs(ids: readonly DocumentId[], close: (id: DocumentId) => Promise<boolean>): Promise<void> {
  for (const id of ids) if (!await close(id)) break;
}

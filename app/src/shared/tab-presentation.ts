import { tabLabel, type TabName } from "./tab-labels.js";
import type { TabLayoutState } from "./tab-layout.js";
import type { DocumentId, Settings } from "./types.js";

export interface TabRow {
  id: DocumentId;
  label: string;
  title: string;
  dirty: boolean;
  selected: boolean;
  pinned: boolean;
  pane: "left" | "right" | "top" | "bottom" | null;
}
export function tabRows(layout: TabLayoutState, names: (TabName & { dirty: boolean })[]): TabRow[] {
  const active = layout.panes.find(pane => pane.paneId === layout.activePane)?.documentId;
  return layout.tabs.map((id, index) => {
    const name = names[index]!;
    const paneIndex = layout.panes.findIndex(pane => pane.documentId === id);
    const pane = layout.panes.length !== 2 || paneIndex < 0 ? null
      : layout.axis === "horizontal" ? paneIndex === 0 ? "left" : "right" : paneIndex === 0 ? "top" : "bottom";
    return { id, label: tabLabel(name, names), title: name.path ?? "Untitled", dirty: name.dirty, selected: id === active, pinned: layout.pinned?.includes(id) ?? false, pane };
  });
}
export function tabNavigationIndex(key: string, current: number, count: number, style: Settings["tabStyle"]): number | undefined {
  if (!count) return;
  if (key === "Enter" || key === " ") return current;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const forward = style === "sidebar" ? "ArrowDown" : "ArrowRight";
  const backward = style === "sidebar" ? "ArrowUp" : "ArrowLeft";
  if (key === forward || key === backward) return (current + (key === forward ? 1 : -1) + count) % count;
}
export function sidebarToggle(settings: Pick<Settings, "tabStyle" | "sidebarCollapsed">): Pick<Settings, "tabStyle" | "sidebarCollapsed"> {
  return { tabStyle: "sidebar", sidebarCollapsed: settings.tabStyle === "sidebar" && !settings.sidebarCollapsed };
}

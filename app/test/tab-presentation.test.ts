import { expect, test } from "bun:test";
import { tabNavigationIndex, tabRows, sidebarToggle } from "../src/shared/tab-presentation";
import { TabLayout } from "../src/shared/tab-layout";
import { DEFAULT_SETTINGS, makeDocumentId } from "../src/shared/types";

test("rows retain order, duplicate folders, dirty state and split pane position", () => {
  const layout = new TabLayout();
  const a = makeDocumentId(1), b = makeDocumentId(2), c = makeDocumentId(3);
  for (const id of [a, b, c]) layout.add(id);
  layout.activate(a); layout.split("horizontal", b);
  const names = [
    { name: "README.md", path: "/one/README.md", dirty: true },
    { name: "README.md", path: "C:\\two\\README.md", dirty: false },
    { name: "Untitled", path: null, dirty: false },
  ];
  expect(tabRows(layout.state, names)).toEqual([
    { id: a, label: "README.md · one", title: "/one/README.md", dirty: true, selected: true, pane: "left", pinned: false },
    { id: b, label: "README.md · two", title: "C:\\two\\README.md", dirty: false, selected: false, pane: "right", pinned: false },
    { id: c, label: "Untitled", title: "Untitled", dirty: false, selected: false, pane: null, pinned: false },
  ]);
  layout.state.axis = "vertical"; layout.activate(b);
  expect(tabRows(layout.state, names).map(row => [row.selected, row.pane])).toEqual([[false, "top"], [true, "bottom"], [false, null]]);
  layout.split("vertical", b);
  expect(tabRows(layout.state, names).every(row => row.pane === null)).toBe(true);
});

test("tab navigation follows orientation, wraps, and handles boundaries", () => {
  for (const [style, next, previous] of [["top", "ArrowRight", "ArrowLeft"], ["sidebar", "ArrowDown", "ArrowUp"]] as const) {
    expect(tabNavigationIndex(next, 2, 3, style)).toBe(0);
    expect(tabNavigationIndex(previous, 0, 3, style)).toBe(2);
    expect(tabNavigationIndex("Home", 1, 3, style)).toBe(0);
    expect(tabNavigationIndex("End", 1, 3, style)).toBe(2);
    expect(tabNavigationIndex("Enter", 1, 3, style)).toBe(1);
    expect(tabNavigationIndex(" ", 1, 3, style)).toBe(1);
    expect(tabNavigationIndex(next, 0, 1, style)).toBe(0);
    expect(tabNavigationIndex(next, 0, 0, style)).toBeUndefined();
    expect(tabNavigationIndex(style === "sidebar" ? "ArrowRight" : "ArrowDown", 1, 3, style)).toBeUndefined();
  }
});

test("View toggle shows a sidebar from top tabs and persists collapse separately", () => {
  expect(sidebarToggle(DEFAULT_SETTINGS)).toEqual({ tabStyle: "sidebar", sidebarCollapsed: false });
  expect(sidebarToggle({ tabStyle: "top", sidebarCollapsed: true })).toEqual({ tabStyle: "sidebar", sidebarCollapsed: false });
  expect(sidebarToggle({ tabStyle: "sidebar", sidebarCollapsed: false })).toEqual({ tabStyle: "sidebar", sidebarCollapsed: true });
  expect(sidebarToggle({ tabStyle: "sidebar", sidebarCollapsed: true })).toEqual({ tabStyle: "sidebar", sidebarCollapsed: false });
});

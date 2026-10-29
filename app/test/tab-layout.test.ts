import { expect, test } from "bun:test";
import { TabLayout } from "../src/shared/tab-layout";
import { makeDocumentId } from "../src/shared/types";
const [a, b, c] = [1, 2, 3].map(makeDocumentId) as [ReturnType<typeof makeDocumentId>, ReturnType<typeof makeDocumentId>, ReturnType<typeof makeDocumentId>];
test("opening and activating tabs retains order and focuses an existing view", () => {
  const tabs = new TabLayout();
  tabs.add(a); tabs.add(b); tabs.add(a);
  expect(tabs.state.tabs).toEqual([a, b]);
  expect(tabs.active?.documentId).toBe(a);
  tabs.cycle(-1); expect(tabs.active?.documentId).toBe(b);
  tabs.cycle(1); expect(tabs.active?.documentId).toBe(a);
});
test("two panes never show one document twice and tab selection focuses its pane", () => {
  const tabs = new TabLayout();
  tabs.add(a); tabs.add(b); tabs.split("horizontal", a);
  const first = tabs.active?.paneId;
  tabs.activate(a);
  expect(tabs.active?.paneId).not.toBe(first);
  tabs.add(c);
  expect(tabs.state.panes.map(p => p.documentId)).toEqual([b, c]);
  tabs.activate(b);
  expect(tabs.active?.paneId).toBe(first);
  tabs.split("vertical", a);
  expect(tabs.state.panes).toHaveLength(2);
  expect(tabs.state.axis).toBe("vertical");
  tabs.focusOther();
  expect(tabs.active?.documentId).toBe(c);
});
test("closing uses a dormant tab, then collapses the pane, then empties the window", () => {
  const tabs = new TabLayout();
  tabs.add(a); tabs.add(b); tabs.split("horizontal", a); tabs.add(c);
  tabs.remove(c);
  expect(tabs.state.panes.map(p => p.documentId)).toEqual([b, a]);
  tabs.remove(b); expect(tabs.state.panes).toHaveLength(1);
  expect(tabs.active?.documentId).toBe(a);
  tabs.remove(a); expect(tabs.state.tabs).toEqual([]); expect(tabs.state.panes).toEqual([]);
});
test("in-place navigation preserves the pane identity and tab position", () => {
  const tabs = new TabLayout(); tabs.add(a); tabs.add(b);
  const pane = tabs.active?.paneId;
  tabs.replace(b, c);
  expect(tabs.state.tabs).toEqual([a, c]);
  expect(tabs.active).toEqual({ paneId: pane, documentId: c });
});

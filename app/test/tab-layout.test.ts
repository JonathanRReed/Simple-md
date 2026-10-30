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


test("Open Quickly keeps the active file when opening beside it and focuses existing views", () => {
  const layout = new TabLayout();
  const one = makeDocumentId(1), two = makeDocumentId(2), three = makeDocumentId(3);
  layout.add(one); const firstPane = layout.active!.paneId;
  layout.openOther(two);
  expect(layout.state.panes.map(p => p.documentId)).toEqual([one, two]);
  expect(layout.active?.documentId).toBe(two);
  layout.focus(firstPane); layout.openOther(three);
  expect(layout.state.panes.map(p => p.documentId)).toEqual([one, three]);
  expect(layout.state.tabs).toEqual([one, two, three]);
  layout.openOther(one);
  expect(layout.active?.documentId).toBe(one);
  expect(layout.state.panes).toHaveLength(2);
});

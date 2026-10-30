import type { RenderedBlocks } from "../../src/shared/render-core";
import type { Bridge } from "../../src/renderer/api";
import type { TabLayoutState } from "../../src/shared/tab-layout";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId, type Settings } from "../../src/shared/types";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function until(fn: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}
export async function runBatch(input: { text: string; rendered: RenderedBlocks; html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  let onDoc: Parameters<Bridge["onDoc"]>[0] | undefined;
  let onLayout: Parameters<Bridge["onLayout"]>[0] | undefined;
  let onSettings: Parameters<Bridge["onSettings"]>[0] | undefined;
  let onCommand: Parameters<Bridge["onCommand"]>[0] | undefined;
  let settings: Settings = { ...DEFAULT_SETTINGS, autosave: false };
  const a = makeDocumentId(1), b = makeDocumentId(2), p0 = makePaneId(0), p1 = makePaneId(1);
  let layout: TabLayoutState = { tabs: [a, b], panes: [{ paneId: p0, documentId: a }], activePane: p0, axis: "horizontal" };
  const ready = new Set<number>();
  const writes: Partial<Settings>[] = [], closed: number[] = [], contexts: number[] = [];
  let edited = "";
  const setSettings = async (patch: Partial<Settings>) => { writes.push(patch); settings = { ...settings, ...patch }; onSettings!(settings); };
  Object.assign(window, { simplemd: {
    ready: async () => ({ settings, platform: "darwin", accent: "#0055aa" }),
    onContextMenu() {}, onNavigate() {}, onClosed() {}, onSaved() {}, onDiskChanged() {}, onTransition() {}, onFlushRequest() {},
    onSettings(cb: typeof onSettings) { onSettings = cb; }, onCommand(cb: typeof onCommand) { onCommand = cb; },
    onDoc(cb: typeof onDoc) { onDoc = cb; }, onLayout(cb: typeof onLayout) { onLayout = cb; },
    perfMarker() {}, documentReady(id: number) { ready.add(id); }, paneMode() {}, releaseView() {}, editing() {}, setDirty() {},
    edit(text: string) { edited = text; },
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: async () => input.rendered,
    readFindText: async () => "", writeFindText: async () => {},
    setSettings,
    activateTab: async (id: typeof a) => {
      const visible = layout.panes.find(pane => pane.documentId === id);
      layout = visible ? { ...layout, activePane: visible.paneId } : { ...layout, panes: [{ paneId: p0, documentId: id }] };
      onLayout!(layout);
    },
    closeTab: async (id: number) => { closed.push(id); return true; },
    tabContextMenu: async (id: number) => { contexts.push(id); },
    command() {},
  } });
  await import("../../src/renderer/app");
  await until(() => !!onDoc && !!onLayout && !!onSettings && !!onCommand, "App did not boot");
  await paint();
  const payload = (id: typeof a, folder: string) => ({ ...input.rendered, documentId: id, paneId: p0, revisionId: makeRevisionId(0), path: `/tmp/${folder}/README.md`, name: "README.md", baseUrl: `file:///tmp/${folder}/`, text: input.text, intent: "read" as const });
  onDoc!(payload(a, "one")); onDoc!(payload(b, "two")); onLayout!(layout);
  await until(() => ready.has(a), "First document did not paint");
  const strip = document.querySelector<HTMLElement>("#tabs")!;
  const divider = document.querySelector<HTMLElement>("#sidebar-divider")!;
  const row = (id: typeof a) => strip.querySelector<HTMLElement>(`[data-document-id="${id}"]`)!;
  const key = (node: HTMLElement, key: string, shiftKey = false) => node.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  const scroller = document.querySelector<HTMLElement>("#read-scroll")!;
  scroller.scrollTop = 600; await paint();
  const scrollTop = scroller.scrollTop, article = document.querySelector("#doc"), pane = document.querySelector(".document-pane");
  const originalRows = [...strip.children];
  await setSettings({ tabStyle: "sidebar" }); await paint();
  assert(strip.getAttribute("aria-orientation") === "vertical" && !strip.hidden && !divider.hidden, "Sidebar orientation or visibility is wrong");
  assert(scroller.scrollTop === scrollTop && document.querySelector("#doc") === article && document.querySelector(".document-pane") === pane, "Placement remounted or scrolled the document");
  assert(originalRows.every(node => node.isConnected), "Placement replaced the tab rows");
  assert(row(a).textContent!.includes("README.md · one"), "Sidebar lost duplicate labels");
  assert(document.querySelector(".tb-title")!.textContent === "README.md" && document.title === "README.md", "Sidebar lost the active title");
  assert(getComputedStyle(row(a).querySelector(".tab-name-start")!).textOverflow === "ellipsis", "Sidebar lost middle truncation");
  await setSettings({ theme: "light" });
  const light = getComputedStyle(strip).backgroundColor;
  await setSettings({ theme: "dark" });
  assert(getComputedStyle(strip).backgroundColor !== light, "Sidebar ignored dark appearance");
  document.body.dataset.platform = "linux";
  assert(!getComputedStyle(strip).backgroundColor.startsWith("rgba"), "Linux sidebar is translucent");
  document.body.dataset.platform = "darwin";
  row(a).focus(); key(row(a), "ArrowDown");
  await until(() => ready.has(b) && row(b).getAttribute("aria-selected") === "true", "Down did not activate the next tab");
  assert(document.activeElement === row(b), "Vertical navigation lost tab focus");
  key(row(b), "ArrowDown"); await until(() => row(a).getAttribute("aria-selected") === "true", "Down did not wrap");
  key(row(a), "End"); await until(() => row(b).getAttribute("aria-selected") === "true", "End did not activate the last tab");
  key(row(b), "Home"); await until(() => row(a).getAttribute("aria-selected") === "true", "Home did not activate the first tab");
  key(row(a), "ArrowUp"); await until(() => row(b).getAttribute("aria-selected") === "true", "Up did not wrap");
  row(a).dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
  row(a).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  key(row(b), "Delete"); row(a).querySelector<HTMLButtonElement>(".tab-close")!.click();
  assert(closed.join(",") === "1,2,1" && contexts.join(",") === "1", "Sidebar close or context actions target the wrong tab");
  assert([...strip.querySelectorAll<HTMLButtonElement>(".tab-close")].every(node => node.tabIndex === -1), "Close buttons break roving focus");

  divider.focus(); key(divider, "ArrowRight");
  assert(divider.getAttribute("aria-valuenow") === "221" && Number(settings.sidebarWidth) === 221, "Keyboard separator did not resize");
  key(divider, "ArrowRight", true); assert(Number(settings.sidebarWidth) === 231, "Shift arrow resize is wrong");
  key(divider, "Home"); assert(Number(settings.sidebarWidth) === 160, "Separator did not clamp to minimum");
  key(divider, "ArrowLeft"); assert(Number(settings.sidebarWidth) === 160, "Separator escaped its minimum");
  key(divider, "End"); assert(Number(settings.sidebarWidth) === 420, "Separator did not clamp to maximum");
  divider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); assert(Number(settings.sidebarWidth) === 220, "Double click did not reset width");
  // Synthetic pointer events have no OS pointer capture. The native smoke case covers capture.
  divider.setPointerCapture = () => {};
  const pointer = (type: string, x: number) => divider.dispatchEvent(new PointerEvent(type, { pointerId: 7, button: 0, clientX: x, bubbles: true, cancelable: true }));
  const count = writes.length;
  pointer("pointerdown", 220); pointer("pointermove", 260); pointer("pointermove", 300);
  assert(writes.length === count, "Dragging writes config before release");
  assert(divider.getAttribute("aria-valuenow") === "220", "Pointer moves bypass frame throttling");
  await paint(); assert(divider.getAttribute("aria-valuenow") === "300", "Drag frame did not apply its latest width");
  pointer("pointerup", 310);
  assert(writes.length === count + 1 && Number(settings.sidebarWidth) === 310, "Drag end did not persist exactly once");
  pointer("pointerdown", 310); pointer("pointermove", 900); await paint();
  assert(divider.getAttribute("aria-valuenow") === "420", "Drag did not clamp");
  pointer("pointercancel", 900);
  assert(Number(settings.sidebarWidth) === 310 && divider.getAttribute("aria-valuenow") === "310", "Canceled resize changed saved width");
  pointer("pointerdown", 310); pointer("pointermove", 340); key(divider, "Escape");
  assert(!document.body.classList.contains("resizing-sidebar") && Number(settings.sidebarWidth) === 310, "Escape left a resize active");
  document.documentElement.dir = "rtl";
  key(divider, "ArrowLeft"); assert(Number(settings.sidebarWidth) === 311, "RTL resize arrow is reversed");
  document.documentElement.dir = "ltr";
  await setSettings({ sidebarCollapsed: true }); await paint();
  assert(strip.hidden && divider.hidden && document.querySelector(".document-pane") === pane, "Collapse replaced the document");
  assert(Math.abs(document.querySelector("#stage")!.getBoundingClientRect().width - innerWidth) < 1, "Collapsed sidebar still takes space");
  await setSettings({ sidebarCollapsed: false });

  onCommand!("mode-source"); await until(() => !!document.querySelector(".cm-content"), "Editor did not mount");
  onCommand!("find"); await until(() => !!document.querySelector('.cm-search input[name="search"]'), "Editor find did not open");
  const search = document.querySelector<HTMLInputElement>('.cm-search input[name="search"]')!;
  const replace = document.querySelector<HTMLInputElement>('.cm-search input[name="replace"]')!;
  search.value = "Paragraph"; search.dispatchEvent(new Event("change", { bubbles: true }));
  replace.value = "Edited"; replace.dispatchEvent(new Event("change", { bubbles: true }));
  document.querySelector<HTMLButtonElement>('.cm-search button[name="replaceAll"]')!.click();
  await until(() => edited.includes("Edited"), "Editor did not retain an unsaved edit");
  document.querySelector<HTMLButtonElement>('.cm-search button[name="close"]')!.click();
  const content = document.querySelector(".cm-content");
  const editorScroll = document.querySelector<HTMLElement>(".cm-scroller")!;
  editorScroll.scrollTop = 500; await paint(); const editorTop = editorScroll.scrollTop;
  for (const tabStyle of ["top", "sidebar", "top", "sidebar"] as const) {
    await setSettings({ tabStyle }); await paint();
    assert(document.querySelector(".cm-content") === content && editorScroll.scrollTop === editorTop, "Style switch remounted or scrolled the editor");
    assert(row(b).dataset.dirty === "true" && row(b).getAttribute("aria-selected") === "true", "Style switch lost dirty or active state");
    assert(!document.querySelector<HTMLElement>('[data-element="dirty"]')!.hidden, "Style switch hid Edited state");
  }
  layout = { ...layout, panes: [{ paneId: p0, documentId: b }, { paneId: p1, documentId: a }] }; onLayout!(layout);
  await until(() => row(a).dataset.pane === "right" && row(b).dataset.pane === "left", "Sidebar did not identify split panes");
  assert(row(a).getAttribute("aria-label")!.includes("right pane"), "Pane marker is not accessible");
  layout = { ...layout, axis: "vertical" }; onLayout!(layout);
  await until(() => row(b).dataset.pane === "top", "Stacked panes have incorrect sidebar markers");
  layout = { tabs: [b], panes: [{ paneId: p0, documentId: b }], activePane: p0, axis: "horizontal" }; onLayout!(layout);
  await until(() => strip.children.length === 1, "Closed tab row remains");
  assert(!strip.hidden, "Sidebar hides a single open tab");
  assert(originalRows[1] === strip.firstElementChild, "Updates replaced the surviving row");
  await setSettings({ tabStyle: "top" }); assert(strip.hidden, "Top strip shows a single tab");
  return { navigation: true, resize: true, placement: true, dirty: true, split: true, appearance: true };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

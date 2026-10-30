import { tabRows } from "../shared/tab-presentation.js";
import { createTabBar } from "./tab-bar.js";
import type { TabLayoutState } from "../shared/tab-layout.js";
import { DEFAULT_SETTINGS, type Command, type DocPayload, type DocumentId, type PaneId, type Settings } from "../shared/types.js";
import { bridge } from "./api.js";
import { createPane, type DormantDocument, type PaneController } from "./pane.js";
import { applyDocumentStyle } from "./document-style.js";
import { mountRenderedHtml, updateFragments } from "./author-html.js";
import { renderDiagrams } from "./diagrams.js";
import { closeOverlays, openPicker, toast } from "./ui.js";

const api = bridge();
const stage = document.querySelector<HTMLElement>("#stage")!;
const strip = document.querySelector<HTMLElement>("#tabs")!;
const tabBar = createTabBar(strip, document.querySelector<HTMLElement>("#sidebar-divider")!, api);
let tabFrame = 0;
let tabTimer: ReturnType<typeof setTimeout> | undefined;
const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
let settings: Settings = DEFAULT_SETTINGS;
let layout: TabLayoutState | undefined;
let firstPane = true;
const documents = new Map<DocumentId, { payload: DocPayload; retained?: DormantDocument; disk?: { text: string; reason?: string } }>();
const panes = new Map<PaneId, { element: HTMLElement; controller: PaneController }>();
let contextTarget: PaneController | undefined;
document.addEventListener("contextmenu", event => {
  contextTarget = [...panes.values()].find(p => event.target instanceof Node && p.element.contains(event.target))?.controller;
});
api.onContextMenu(context => { if (contextTarget) void contextTarget.contextMenu(context).catch(console.error); });
const active = () => layout ? panes.get(layout.activePane)?.controller : undefined;
function applyWindowSettings(next: Settings): void {
  applyDocumentStyle(next);
  tabBar.configure(next);
  document.documentElement.style.setProperty("--tab-accent", next.systemAccent ?? "Highlight");
  document.documentElement.dataset.theme = next.theme;
  document.documentElement.style.colorScheme = next.theme === "system" ? "light dark" : next.theme;
  document.documentElement.style.setProperty("--zoom", String(next.zoom));
}
function syncChrome(): void {
  if (!layout) return;
  const controller = active();
  const element = panes.get(layout.activePane)?.element;
  for (const key of ["documentPath", "documentPainted", "firstReadable", "fullyHighlighted", "renderComplete", "documentId", "revisionId"]) {
    if (element?.dataset[key] === undefined) delete document.documentElement.dataset[key];
    else document.documentElement.dataset[key] = element.dataset[key];
  }
  const windowTitle = document.querySelector<HTMLElement>(".tb-title")!;
  windowTitle.textContent = controller?.meta.name ?? "SimpleMD";
  document.title = controller?.meta.name ?? "SimpleMD";
  windowTitle.title = controller?.meta.path ?? "";
  if (settings.tabStyle === "sidebar") {
    // Let the document paint before populating sidebar rows. Coalesce load and dirty notifications.
    if (!tabFrame && tabTimer === undefined) tabFrame = requestAnimationFrame(() => {
      tabFrame = 0;
      tabTimer = setTimeout(() => { tabTimer = undefined; syncTabs(); }, 0);
    });
  } else {
    cancelAnimationFrame(tabFrame); tabFrame = 0;
    clearTimeout(tabTimer); tabTimer = undefined;
    syncTabs();
  }
  for (const [id, pane] of panes) {
    pane.element.dataset.active = String(id === layout.activePane);
    pane.controller.activeChanged(id === layout.activePane);
  }
}
function syncTabs(): void {
  if (!layout) return;
  const names = layout.tabs.map(id => {
    const mounted = [...panes.values()].find(p => p.controller.documentId === id)?.controller;
    const tab = documents.get(id);
    const meta = mounted?.meta ?? tab?.retained?.state.meta ?? tab?.payload ?? { name: "Untitled", path: null };
    return { ...meta, dirty: !!(mounted?.meta.dirty ?? tab?.retained?.state.dirty ?? tab?.payload.dirty) };
  });
  tabBar.render(tabRows(layout, names));
}
function tabMetaForPalette(id: DocumentId) {
  return [...panes.values()].find(p => p.controller.documentId === id)?.controller.meta
    ?? documents.get(id)?.retained?.state.meta ?? documents.get(id)?.payload ?? { name: "Untitled", path: null };
}
function stash(entry: { element: HTMLElement; controller: PaneController }): void {
  const tab = documents.get(entry.controller.documentId);
  const snapshot = entry.controller.suspend();
  if (tab) {
    tab.retained = snapshot;
    tab.payload = { ...tab.payload, text: snapshot.state.readText, revisionId: snapshot.state.revisionId, blocks: [], stream: undefined };
  }
}
function mountLayout(next: TabLayoutState): void {
  closeOverlays();
  const previousActive = layout?.activePane;
  for (const [id, entry] of panes) entry.controller.activeChanged(next.activePane === id && next.panes.some(slot => slot.paneId === id && slot.documentId === entry.controller.documentId));
  layout = next;
  stage.dataset.axis = next.axis;
  stage.dataset.panes = String(next.panes.length);
  for (const [id, entry] of panes) {
    if (!next.panes.some(p => p.paneId === id)) {
      stash(entry); entry.element.remove(); panes.delete(id);
    }
  }
  for (const slot of next.panes) {
    let entry = panes.get(slot.paneId);
    if (!entry) {
      const fragment = template.content.cloneNode(true) as DocumentFragment;
      const element = fragment.querySelector<HTMLElement>(".document-pane")!;
      for (const node of element.querySelectorAll<HTMLElement>("[id]")) {
        node.dataset.element = node.id;
        if (!firstPane) node.id = `${node.id}-${slot.paneId}`;
      }
      firstPane = false;
      element.dataset.paneId = String(slot.paneId);
      element.addEventListener("pointerdown", () => {
        if (layout?.activePane !== slot.paneId) void api.focusPane(slot.paneId);
      }, { capture: true });
      element.addEventListener("focusin", () => {
        if (layout?.activePane !== slot.paneId) void api.focusPane(slot.paneId);
      });
      stage.append(element);
      const controller = createPane(element, slot.paneId, {
        active: () => layout?.activePane === slot.paneId,
        changed: syncChrome,
        tabs: () => (layout?.tabs ?? []).map(id => ({ id, ...tabMetaForPalette(id) })),
      });
      entry = { element, controller }; panes.set(slot.paneId, entry);
      new MutationObserver(syncChrome).observe(element, { attributes: true, attributeFilter: ["data-document-path", "data-document-painted", "data-first-readable", "data-fully-highlighted", "data-render-complete", "data-document-id", "data-revision-id"] });
      controller.settings(settings);
    }
    if (entry.controller.documentId !== slot.documentId) {
      if (entry.element.dataset.documentId !== undefined) stash(entry);
      const tab = documents.get(slot.documentId);
      if (!tab) continue;
      entry.element.id = `document-${slot.documentId}`;
      entry.element.setAttribute("role", "tabpanel");
      entry.element.setAttribute("aria-label", tab.payload.name);
      void entry.controller.load(tab.payload, tab.retained).then(() => {
        const disk = tab.disk ?? tab.retained?.disk;
        if (disk && entry?.controller.documentId === slot.documentId) {
          entry.controller.diskChanged(disk.text, slot.documentId, disk.reason); tab.disk = undefined;
          if (tab.retained) tab.retained.disk = undefined;
        }
        syncChrome();
      });
    } else if (entry.element.dataset.documentPainted !== undefined) {
      const id = slot.documentId;
      delete entry.element.dataset.firstReadable;
      delete entry.element.dataset.documentPainted;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (entry?.controller.documentId === id) {
          const file = documents.get(id)?.payload.path ?? "";
          entry.element.dataset.firstReadable = file;
          entry.element.dataset.documentPainted = file;
          api.perfMarker(id, "first-readable"); api.documentReady(id);
        }
      }));
    }
  }
  syncChrome();
  if (previousActive !== next.activePane && !strip.contains(document.activeElement)) active()?.focus();
}

async function printView(): Promise<void> {
  document.body.classList.add("print");
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  stage.append(fragment);
  api.onPrintDoc((doc, s) => {
    applyWindowSettings(s);
    const article = document.querySelector<HTMLElement>("#doc")!;
    document.querySelector<HTMLElement>("#empty")!.hidden = true;
    article.hidden = false;
    for (const block of doc.blocks) {
      const node = document.createElement("div"); mountRenderedHtml(node, block, s.remoteImages); article.append(node);
    }
    updateFragments(article);
    void (async () => {
      await renderDiagrams(article);
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "katex.min.css";
      await new Promise<void>(resolve => { css.onload = () => resolve(); css.onerror = () => resolve(); document.head.append(css); });
      await document.fonts.ready;
      await Promise.all([...article.querySelectorAll("img")].filter(image => image.hasAttribute("src") || image.currentSrc || image.closest("picture")?.querySelector("source[srcset]")).map(async image => {
        image.loading = "eager";
        try { await image.decode(); } catch (error) { console.warn("simplemd: skipped print image", error); }
      }));
      api.printReady();
    })().catch(error => api.printReady(String(error)));
  });
}
async function boot(): Promise<void> {
  if (new URLSearchParams(location.search).has("print")) { await printView(); return; }
  api.onNavigate((id, target) => { const pane = [...panes.values()].find(entry => entry.controller.documentId === id); if (pane) void pane.controller.navigate(target).catch(console.error); });
  api.onDoc(payload => { documents.set(payload.documentId, { payload }); });
  api.onLayout(mountLayout);
  api.onClosed(id => { documents.delete(id); });
  api.onSaved(result => {
    const tab = documents.get(result.documentId);
    const mounted = [...panes.values()].find(p => p.controller.documentId === result.documentId);
    if (mounted) mounted.controller.saved(result);
    else if (tab?.retained) {
      tab.retained.state.savedText = result.text;
      tab.retained.state.dirty = tab.retained.state.readText !== result.text;
      tab.retained.state.meta = result;
    }
    syncChrome();
  });
  api.onDiskChanged((text, id, reason) => {
    const mounted = [...panes.values()].find(p => p.controller.documentId === id);
    if (mounted) mounted.controller.diskChanged(text, id, reason);
    else { const tab = documents.get(id); if (tab) { tab.disk = { text, reason }; if (tab.retained) tab.retained.state.diskConflict = true; } }
  });
  api.onTransition(busy => { for (const pane of panes.values()) pane.controller.transition(busy); });
  let quicklyLoading = false;
  api.onCommand((command, id) => {
    if (command === "open-quickly") {
      if (quicklyLoading) return;
      quicklyLoading = true;
      closeOverlays();
      const tabs = (layout?.tabs ?? []).flatMap(id => { const file = tabMetaForPalette(id).path; return file ? [{ path: file, source: "tab" as const }] : []; });
      const seen = new Set<string>();
      const instant = [...tabs, ...settings.recents.map(path => ({ path, source: "recent" as const }))].filter(file => {
        if (!/\.(md|mdx|markdown|mdown|mkd)$/i.test(file.path) || seen.has(file.path)) return false;
        seen.add(file.path); return true;
      });
      const restore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      let closed = false;
      // Paint tabs and recents synchronously, before fetching the lazy search module.
      openPicker("Open Quickly", instant.slice(0, 200).map(file => {
        const at = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"));
        return { label: file.path.slice(at + 1), parent: file.path.slice(0, at), run: (otherPane?: boolean) => {
          void api.quicklyOpen(file.path, !!otherPane).then(opened => { if (!opened) toast("Couldn't open this file."); }).catch(() => toast("Couldn't open this file."));
        } };
      }), () => { closed = true; if (restore?.isConnected) restore.focus({ preventScroll: true }); });
      void import("./open-quickly.js").then(({ openQuickly }) => {
        if (closed) return;
        const query = document.querySelector<HTMLInputElement>("#picker-input")!.value.slice(0, 256);
        closeOverlays();
        openQuickly(api, settings.openQuicklyScope, instant, query);
      }).finally(() => { quicklyLoading = false; });
      return;
    }
    const target = id === undefined ? active() : [...panes.values()].find(pane => pane.controller.documentId === id)?.controller;
    target?.command(command);
  });
  api.onSettings(next => {
    const modeChanged = settings.mode !== next.mode;
    settings = next;
    applyWindowSettings(next);
    syncChrome();
    for (const pane of panes.values()) pane.controller.settings(next);
    if (modeChanged) active()?.command(next.mode === "live" ? "mode-live" : next.mode === "source" ? "mode-source" : "mode-split");
  });
  api.onFlushRequest((request, id) => {
    const mounted = [...panes.values()].find(p => p.controller.documentId === id);
    const tab = documents.get(id);
    const state = tab?.retained?.state;
    if (mounted) api.flushResponse(request, mounted.controller.flush());
    else if (state) api.flushResponse(request, { documentId: id, revisionId: state.revisionId, dirty: state.dirty, conflict: state.diskConflict, text: state.readText });
  });
  const ready = await api.ready();
  settings = ready.settings;
  document.body.dataset.platform = ready.platform;
  applyWindowSettings(settings);
  document.querySelector("#welcome-open")!.addEventListener("click", () => void api.openDialog());
  document.querySelector("#welcome-new")!.addEventListener("click", () => api.command("new"));
  document.addEventListener("keydown", e => {
    if (e.isComposing) return;
    const mod = ready.platform === "darwin" ? e.metaKey : e.ctrlKey;
    let command: Command | undefined;
    const sidebarShortcut = ready.platform === "darwin" ? e.ctrlKey && e.metaKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
    if (sidebarShortcut && !e.shiftKey && e.key.toLowerCase() === "s") command = "toggle-tab-sidebar";
    else if (mod && e.shiftKey && e.key.toLowerCase() === "o") command = e.altKey ? "outline" : "open-quickly";
    else if (mod && e.key === ",") command = "preferences";
    else if (mod && e.key.toLowerCase() === "t") command = "new";
    else if (mod && e.key.toLowerCase() === "w") command = "close-tab";
    else if (e.ctrlKey && e.key === "Tab") command = e.shiftKey ? "previous-tab" : "next-tab";
    else if (mod && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) command = e.code === "BracketLeft" ? "previous-tab" : "next-tab";
    else if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key) && layout) {
      e.preventDefault(); const index = Number(e.key) === 9 ? layout.tabs.length - 1 : Number(e.key) - 1;
      const id = layout.tabs[index]; if (id !== undefined) void api.activateTab(id); return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "m") command = "mark-seen";
    if (command) { e.preventDefault(); api.command(command); }
  }, { capture: true });
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", e => {
    const handled = e.defaultPrevented; e.preventDefault();
    if (handled) return;
    for (const file of e.dataTransfer?.files ?? []) if (!file.type.startsWith("image/")) void api.openPath(api.pathForFile(file));
  });
  // Preload only the editor module, never a dormant editor view.
  setTimeout(() => void import("./editor.js"), 0);
}
void boot();

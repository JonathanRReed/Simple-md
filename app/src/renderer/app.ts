import type { TabLayoutState } from "../shared/tab-layout.js";
import { DEFAULT_SETTINGS, type Command, type DocPayload, type DocumentId, type PaneId, type Settings } from "../shared/types.js";
import { bridge } from "./api.js";
import { createPane, type DormantDocument, type PaneController } from "./pane.js";
import { createPreferences } from "./preferences.js";
import { mountRenderedHtml, updateFragments } from "./author-html.js";
import { renderDiagrams } from "./diagrams.js";
import { closeOverlays } from "./ui.js";

const api = bridge();
const stage = document.querySelector<HTMLElement>("#stage")!;
const strip = document.querySelector<HTMLElement>("#tabs")!;
const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
let settings: Settings = DEFAULT_SETTINGS;
let layout: TabLayoutState | undefined;
let preferences: ReturnType<typeof createPreferences>;
let firstPane = true;
const documents = new Map<DocumentId, { payload: DocPayload; retained?: DormantDocument; disk?: { text: string; reason?: string } }>();
const panes = new Map<PaneId, { element: HTMLElement; controller: PaneController }>();
const active = () => layout ? panes.get(layout.activePane)?.controller : undefined;
function syncChrome(): void {
  if (!layout) return;
  const controller = active();
  const element = panes.get(layout.activePane)?.element;
  if (element) {
    for (const key of ["documentPath", "documentPainted", "firstReadable", "fullyHighlighted", "renderComplete", "documentId", "revisionId"]) {
      if (element.dataset[key] === undefined) delete document.documentElement.dataset[key];
      else document.documentElement.dataset[key] = element.dataset[key];
    }
  }
  const ids = layout.tabs;
  strip.hidden = ids.length <= 1;
  strip.replaceChildren(...ids.map((id, index) => {
    const mounted = [...panes.values()].find(p => p.controller.documentId === id)?.controller;
    const tab = documents.get(id);
    const meta = mounted?.meta ?? tab?.retained?.state.meta ?? tab?.payload;
    const dirty = mounted?.meta.dirty ?? tab?.retained?.state.dirty ?? tab?.payload.dirty;
    const button = document.createElement("div");
    button.className = "tab";
    button.dataset.documentId = String(id);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(controller?.documentId === id));
    button.setAttribute("aria-controls", `document-${id}`);
    button.tabIndex = controller?.documentId === id ? 0 : -1;
    button.title = meta?.path ?? "Untitled";
    const title = document.createElement("span");
    title.className = "tab-name";
    title.textContent = meta?.name ?? "Untitled";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = dirty ? "●" : "×";
    close.setAttribute("aria-label", `Close ${title.textContent}`);
    close.addEventListener("click", e => { e.stopPropagation(); void api.closeTab(id); });
    button.append(title, close);
    button.addEventListener("click", () => void api.activateTab(id));
    button.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void api.activateTab(id); }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault(); const next = ids[(index + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
        if (next !== undefined) void api.activateTab(next);
      }
    });
    return button;
  }));
  for (const [id, pane] of panes) pane.element.dataset.active = String(id === layout.activePane);
}
function stash(entry: { element: HTMLElement; controller: PaneController }): void {
  const tab = documents.get(entry.controller.documentId);
  const snapshot = entry.controller.suspend();
  if (tab) tab.retained = snapshot;
}
function mountLayout(next: TabLayoutState): void {
  closeOverlays();
  const previousActive = layout?.activePane;
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
        changed: syncChrome, preferences: () => preferences.open(), preferencesOpen: () => preferences?.isOpen() ?? false,
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
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (entry?.controller.documentId === id) api.perfMarker(id, "first-readable");
      }));
    }
  }
  syncChrome();
  if (previousActive !== next.activePane) active()?.focus();
}

async function printView(): Promise<void> {
  document.body.classList.add("print");
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  stage.append(fragment);
  api.onPrintDoc((doc, s) => {
    document.documentElement.dataset.theme = s.theme;
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
  api.onCommand(command => active()?.command(command));
  api.onSettings(next => {
    const modeChanged = settings.mode !== next.mode;
    settings = next; preferences?.sync(next);
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
  document.documentElement.style.setProperty("--tab-accent", ready.accent);
  document.body.dataset.platform = ready.platform;
  document.documentElement.dataset.theme = settings.theme;
  preferences = createPreferences({ settings: () => settings, change: patch => api.setSettings(patch) });
  document.querySelector("#preferences-btn")!.addEventListener("click", () => preferences.open());
  document.querySelector("#welcome-open")!.addEventListener("click", () => void api.openDialog());
  document.querySelector("#welcome-new")!.addEventListener("click", () => api.command("new"));
  document.addEventListener("keydown", e => {
    if (e.isComposing) return;
    const mod = ready.platform === "darwin" ? e.metaKey : e.ctrlKey;
    let command: Command | undefined;
    if (mod && e.key.toLowerCase() === "t") command = "new";
    else if (mod && e.key.toLowerCase() === "w") command = "close-tab";
    else if (e.ctrlKey && e.key === "Tab") command = e.shiftKey ? "previous-tab" : "next-tab";
    else if (mod && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) command = e.code === "BracketLeft" ? "previous-tab" : "next-tab";
    else if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key) && layout) {
      e.preventDefault(); const index = Number(e.key) === 9 ? layout.tabs.length - 1 : Number(e.key) - 1;
      const id = layout.tabs[index]; if (id !== undefined) void api.activateTab(id); return;
    }
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

import { isDocumentId, makeDocumentId, type DocumentId, type RevisionId, type RequestId } from "./shared/types.js";
import { applyBlockDelta, isBlockDelta } from "./shared/block-delta.js";
import type { RenderedBlock } from "./shared/render-core.js";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const on = <T extends unknown[]>(channel: string, cb: (...args: T) => void) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...(args as T)));
};

let performanceTracing = false;
let activeDocumentId = makeDocumentId(0);
const renderStates = new Map<DocumentId, RenderedBlock[]>();
const viewGenerations = new Map<DocumentId, number>();

contextBridge.exposeInMainWorld("simplemd", {
  ready: async () => {
    const ready = await ipcRenderer.invoke("smd:ready");
    performanceTracing = ready.performanceTracing === true;
    return ready;
  },

  readFindText: () => ipcRenderer.invoke("smd:find-read"),
  writeFindText: (text: string) => ipcRenderer.invoke("smd:find-write", text),
  onContextMenu: (cb: (context: import("./shared/native-context.js").NativeContext) => void) => on("smd:context-request", cb),
  contextMenu: (context: import("./shared/native-context.js").NativeContext, id: DocumentId) => ipcRenderer.invoke("smd:context-menu", context, id),
  onLayout: (cb: (state: import("./shared/tab-layout.js").TabLayoutState) => void) => on("smd:layout", (state: import("./shared/tab-layout.js").TabLayoutState) => {
    const active = state.panes.find(p => p.paneId === state.activePane);
    if (active) activeDocumentId = active.documentId;
    cb(state);
  }),
  onNavigate: (cb: (id: DocumentId, target: import("./shared/types.js").DocumentLocation) => void) => on("smd:navigate", cb),
  onClosed: (cb: (id: DocumentId) => void) => on("smd:closed", (id: DocumentId) => { renderStates.delete(id); cb(id); }),
  releaseView: (id: DocumentId) => { renderStates.delete(id); viewGenerations.set(id, (viewGenerations.get(id) ?? 0) + 1); ipcRenderer.send("smd:release-view", id); },
  activateTab: async (id: DocumentId) => { await ipcRenderer.invoke("smd:activate-tab", id); activeDocumentId = id; },
  paneMode: (id: number, mode: string) => ipcRenderer.send("smd:pane-mode", id, mode),
  focusPane: async (id: number) => {
    const documentId: unknown = await ipcRenderer.invoke("smd:focus-pane", id);
    if (isDocumentId(documentId)) activeDocumentId = documentId;
  },
  closeTab: (id: DocumentId) => ipcRenderer.invoke("smd:close-tab", id),
  tabContextMenu: (id: DocumentId) => ipcRenderer.invoke("smd:tab-context-menu", id),
  onDoc: (cb: (doc: { documentId: DocumentId }) => void) => on("smd:doc", (doc: { documentId: DocumentId }) => { activeDocumentId = doc.documentId; cb(doc); }),
  onSettings: (cb: (s: unknown) => void) => on("smd:settings", cb),
  onCommand: (cb: (cmd: string, id?: DocumentId) => void) => on("smd:cmd", cb),
  onDiskChanged: (cb: (text: string, documentId: DocumentId, readOnlyReason?: string) => void) => on("smd:disk-changed", cb),
  onTransition: (cb: (busy: boolean) => void) => on("smd:transition", cb),
  onSaved: (cb: (result: unknown) => void) => on("smd:saved", cb),
  onFlushRequest: (cb: (id: RequestId, documentId: DocumentId) => void) => on("smd:flush-request", cb),
  onPrintDoc: (cb: (doc: unknown, settings: unknown) => void) => on("smd:print-doc", cb),

  flushResponse: (id: RequestId, result: { dirty: boolean; text: string; documentId: DocumentId; revisionId: RevisionId; conflict: boolean }) =>
    ipcRenderer.send("smd:flush-response", id, result),
  setDirty: (dirty: boolean, documentId: DocumentId) => ipcRenderer.send("smd:dirty", dirty, documentId),
  edit: (text: string, documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.send("smd:edit", text, documentId, revisionId),
  editing: (documentId: DocumentId) => ipcRenderer.send("smd:editing", documentId),
  perfMarker: (documentId: DocumentId, marker: string) => {
    if (performanceTracing) ipcRenderer.send("smd:perf-marker", documentId, marker, performance.timeOrigin + performance.now());
  },
  documentReady: (documentId: DocumentId) => ipcRenderer.send("smd:document-ready", documentId),
  acceptDisk: (text: string, documentId: DocumentId, automatic = false) => ipcRenderer.invoke("smd:accept-disk", text, documentId, automatic),
  changes: (documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.invoke("smd:changes", documentId, revisionId),
  markSeen: (documentId: DocumentId, revisionId: RevisionId, watchOnly = false) => ipcRenderer.invoke("smd:mark-seen", documentId, revisionId, watchOnly),
  gitStatus: (documentId: DocumentId) => ipcRenderer.invoke("smd:git-status", documentId),
  headChanges: (documentId: DocumentId, enabled: boolean) => ipcRenderer.invoke("smd:head-changes", documentId, enabled),
  printReady: (error?: string) => ipcRenderer.send("smd:print-ready", error),

  mdxRanges: (text: string, documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.invoke("smd:mdx-ranges", text, documentId, revisionId),
  nextBlocks: (stream: number, documentId: DocumentId) => ipcRenderer.invoke("smd:next-blocks", stream, documentId),
  renderBlocks: async (text: string, documentId: DocumentId, revisionId: RevisionId) => {
    const generation = viewGenerations.get(documentId) ?? 0;
    const delta: unknown = await ipcRenderer.invoke("smd:render-blocks", text, documentId, revisionId, renderStates.has(documentId));
    if (!isBlockDelta(delta)) throw new Error("Invalid block delta");
    const result = applyBlockDelta(renderStates.get(documentId) ?? [], delta);
    if (generation === (viewGenerations.get(documentId) ?? 0)) renderStates.set(documentId, result.blocks);
    return result;
  },
  renderFragment: (text: string, documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.invoke("smd:render-fragment", text, documentId, revisionId),
  save: (text: string, forceDialog: boolean, documentId: DocumentId) => ipcRenderer.invoke("smd:save", text, forceDialog, documentId),
  saveCopy: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:save-copy", text, documentId),
  saveImage: (bytes: Uint8Array, ext: string, documentId: DocumentId) => ipcRenderer.invoke("smd:save-image", bytes, ext, documentId),
  prepareDragExport: (text: string, documentId: DocumentId, revisionId: RevisionId, format: "html" | "pdf") => ipcRenderer.invoke("smd:prepare-drag-export", text, documentId, revisionId, format),
  startDragExport: (documentId: DocumentId, revisionId: RevisionId, token: string) => ipcRenderer.send("smd:start-drag-export", documentId, revisionId, token),
  exportPdf: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:export-pdf", text, documentId),
  exportHtml: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:export-html", text, documentId),
  print: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:print", text, documentId),

  onQuicklyResults: (cb: (request: number, matches: import("./shared/open-quickly.js").QuicklyMatch[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: number, matches: import("./shared/open-quickly.js").QuicklyMatch[]) => cb(request, matches);
    ipcRenderer.on("smd:quickly-results", listener);
    return () => ipcRenderer.removeListener("smd:quickly-results", listener);
  },
  quicklyQuery: (query: string, scope: string, request: number) => ipcRenderer.invoke("smd:quickly-query", query, scope, request),
  quicklyClose: () => ipcRenderer.send("smd:quickly-close"),
  quicklyOpen: (file: string, otherPane: boolean) => ipcRenderer.invoke("smd:quickly-open", file, otherPane),
  openDialog: () => ipcRenderer.invoke("smd:open-dialog"),
  openPath: (p: string, intent?: "read" | "edit", inPlace = false, documentId = activeDocumentId) => ipcRenderer.invoke("smd:open-path", p, intent, documentId, inPlace),
  openLink: (href: string, intent?: "read" | "edit", newTab = false, documentId = activeDocumentId) => ipcRenderer.invoke("smd:open-link", href, intent, documentId, newTab),
  setSettings: (patch: unknown) => ipcRenderer.invoke("smd:set-settings", patch),
  command: (cmd: string, documentId = activeDocumentId) => ipcRenderer.send("smd:command", cmd, documentId),
  hide: () => ipcRenderer.send("smd:hide", activeDocumentId),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
});

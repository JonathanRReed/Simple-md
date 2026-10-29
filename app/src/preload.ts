import { makeDocumentId, type DocumentId, type RevisionId, type RequestId } from "./shared/types.js";
import { applyBlockDelta, isBlockDelta } from "./shared/block-delta.js";
import type { RenderedBlock } from "./shared/render-core.js";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const on = <T extends unknown[]>(channel: string, cb: (...args: T) => void) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...(args as T)));
};

let performanceTracing = false;
let activeDocumentId = makeDocumentId(0);
const renderStates = new Map<DocumentId, RenderedBlock[]>();

contextBridge.exposeInMainWorld("simplemd", {
  ready: async () => {
    const ready = await ipcRenderer.invoke("smd:ready");
    performanceTracing = ready.performanceTracing === true;
    return ready;
  },

  onLayout: (cb: (state: import("./shared/tab-layout.js").TabLayoutState) => void) => on("smd:layout", (state: import("./shared/tab-layout.js").TabLayoutState) => {
    const active = state.panes.find(p => p.paneId === state.activePane);
    if (active) activeDocumentId = active.documentId;
    cb(state);
  }),
  onClosed: (cb: (id: DocumentId) => void) => on("smd:closed", (id: DocumentId) => { renderStates.delete(id); cb(id); }),
  activateTab: (id: DocumentId) => ipcRenderer.invoke("smd:activate-tab", id),
  focusPane: (id: number) => ipcRenderer.invoke("smd:focus-pane", id),
  closeTab: (id: DocumentId) => ipcRenderer.invoke("smd:close-tab", id),
  onDoc: (cb: (doc: { documentId: DocumentId }) => void) => on("smd:doc", (doc: { documentId: DocumentId }) => { activeDocumentId = doc.documentId; cb(doc); }),
  onSettings: (cb: (s: unknown) => void) => on("smd:settings", cb),
  onCommand: (cb: (cmd: string) => void) => on("smd:cmd", cb),
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
  acceptDisk: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:accept-disk", text, documentId),
  printReady: (error?: string) => ipcRenderer.send("smd:print-ready", error),

  mdxRanges: (text: string, documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.invoke("smd:mdx-ranges", text, documentId, revisionId),
  nextBlocks: (stream: number, documentId: DocumentId) => ipcRenderer.invoke("smd:next-blocks", stream, documentId),
  renderBlocks: async (text: string, documentId: DocumentId, revisionId: RevisionId) => {
    const delta: unknown = await ipcRenderer.invoke("smd:render-blocks", text, documentId, revisionId);
    if (!isBlockDelta(delta)) throw new Error("Invalid block delta");
    const result = applyBlockDelta(renderStates.get(documentId) ?? [], delta);
    renderStates.set(documentId, result.blocks);
    return result;
  },
  renderFragment: (text: string, documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.invoke("smd:render-fragment", text, documentId, revisionId),
  save: (text: string, forceDialog: boolean, documentId: DocumentId) => ipcRenderer.invoke("smd:save", text, forceDialog, documentId),
  saveImage: (bytes: Uint8Array, ext: string, documentId: DocumentId) => ipcRenderer.invoke("smd:save-image", bytes, ext, documentId),
  exportPdf: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:export-pdf", text, documentId),
  exportHtml: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:export-html", text, documentId),
  print: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:print", text, documentId),

  openDialog: () => ipcRenderer.invoke("smd:open-dialog"),
  openPath: (p: string, intent?: "read" | "edit", inPlace = false, documentId = activeDocumentId) => ipcRenderer.invoke("smd:open-path", p, intent, documentId, inPlace),
  openLink: (href: string, intent?: "read" | "edit", newTab = false, documentId = activeDocumentId) => ipcRenderer.invoke("smd:open-link", href, intent, documentId, newTab),
  setSettings: (patch: unknown) => ipcRenderer.invoke("smd:set-settings", patch),
  command: (cmd: string, documentId = activeDocumentId) => ipcRenderer.send("smd:command", cmd, documentId),
  hide: () => ipcRenderer.send("smd:hide", activeDocumentId),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
});

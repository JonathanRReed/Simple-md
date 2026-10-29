import { makeDocumentId, type DocumentId, type RevisionId, type RequestId } from "./shared/types.js";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const on = <T extends unknown[]>(channel: string, cb: (...args: T) => void) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...(args as T)));
};

let performanceTracing = false;
let activeDocumentId = makeDocumentId(0);

contextBridge.exposeInMainWorld("simplemd", {
  ready: async () => {
    const ready = await ipcRenderer.invoke("smd:ready");
    performanceTracing = ready.performanceTracing === true;
    return ready;
  },

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
    if (performanceTracing) ipcRenderer.send("smd:perf-marker", documentId, marker);
  },
  documentReady: (documentId: DocumentId) => ipcRenderer.send("smd:document-ready", documentId),
  acceptDisk: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:accept-disk", text, documentId),
  printReady: (error?: string) => ipcRenderer.send("smd:print-ready", error),

  mdxRanges: (text: string, documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.invoke("smd:mdx-ranges", text, documentId, revisionId),
  renderBlocks: (text: string, documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.invoke("smd:render-blocks", text, documentId, revisionId),
  renderFragment: (text: string, documentId: DocumentId, revisionId: RevisionId) => ipcRenderer.invoke("smd:render-fragment", text, documentId, revisionId),
  save: (text: string, forceDialog: boolean, documentId: DocumentId) => ipcRenderer.invoke("smd:save", text, forceDialog, documentId),
  saveImage: (bytes: Uint8Array, ext: string, documentId: DocumentId) => ipcRenderer.invoke("smd:save-image", bytes, ext, documentId),
  exportPdf: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:export-pdf", text, documentId),
  exportHtml: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:export-html", text, documentId),
  print: (text: string, documentId: DocumentId) => ipcRenderer.invoke("smd:print", text, documentId),

  openDialog: () => ipcRenderer.invoke("smd:open-dialog"),
  openPath: (p: string, intent?: "peek" | "edit") => ipcRenderer.invoke("smd:open-path", p, intent, activeDocumentId),
  openLink: (href: string, intent?: "peek" | "edit") => ipcRenderer.invoke("smd:open-link", href, intent, activeDocumentId),
  setSettings: (patch: unknown) => ipcRenderer.invoke("smd:set-settings", patch),
  command: (cmd: string) => ipcRenderer.send("smd:command", cmd, activeDocumentId),
  hide: () => ipcRenderer.send("smd:hide", activeDocumentId),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
});

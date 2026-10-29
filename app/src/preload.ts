import { applyBlockDelta, isBlockDelta } from "./shared/block-delta.js";
import type { RenderedBlock } from "./shared/render-core.js";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const on = <T extends unknown[]>(channel: string, cb: (...args: T) => void) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...(args as T)));
};

let performanceTracing = false;
let renderState: { id: number; blocks: RenderedBlock[] } | undefined;

contextBridge.exposeInMainWorld("simplemd", {
  ready: async () => {
    const ready = await ipcRenderer.invoke("smd:ready");
    performanceTracing = ready.performanceTracing === true;
    return ready;
  },

  onDoc: (cb: (doc: unknown) => void) => on("smd:doc", cb),
  onSettings: (cb: (s: unknown) => void) => on("smd:settings", cb),
  onCommand: (cb: (cmd: string) => void) => on("smd:cmd", cb),
  onDiskChanged: (cb: (text: string, documentId: number, readOnlyReason?: string) => void) => on("smd:disk-changed", cb),
  onTransition: (cb: (busy: boolean) => void) => on("smd:transition", cb),
  onSaved: (cb: (result: unknown) => void) => on("smd:saved", cb),
  onFlushRequest: (cb: (id: number) => void) => on("smd:flush-request", cb),
  onPrintDoc: (cb: (doc: unknown, settings: unknown) => void) => on("smd:print-doc", cb),

  flushResponse: (id: number, result: { dirty: boolean; text: string; documentId: number; conflict: boolean }) =>
    ipcRenderer.send("smd:flush-response", id, result),
  setDirty: (dirty: boolean, documentId: number) => ipcRenderer.send("smd:dirty", dirty, documentId),
  editing: (documentId: number) => ipcRenderer.send("smd:editing", documentId),
  perfMarker: (documentId: number, marker: string) => {
    if (performanceTracing) ipcRenderer.send("smd:perf-marker", documentId, marker);
  },
  documentReady: (documentId: number) => ipcRenderer.send("smd:document-ready", documentId),
  acceptDisk: (text: string, documentId: number) => ipcRenderer.invoke("smd:accept-disk", text, documentId),
  printReady: (error?: string) => ipcRenderer.send("smd:print-ready", error),

  mdxRanges: (text: string, documentId: number) => ipcRenderer.invoke("smd:mdx-ranges", text, documentId),
  nextBlocks: (stream: number, documentId: number) => ipcRenderer.invoke("smd:next-blocks", stream, documentId),
  renderBlocks: async (text: string, documentId: number) => {
    const delta: unknown = await ipcRenderer.invoke("smd:render-blocks", text, documentId);
    if (!isBlockDelta(delta)) throw new Error("Invalid block delta");
    const result = applyBlockDelta(renderState?.id === documentId ? renderState.blocks : [], delta);
    renderState = { id: documentId, blocks: result.blocks };
    return result;
  },
  renderFragment: (text: string, documentId: number) => ipcRenderer.invoke("smd:render-fragment", text, documentId),
  save: (text: string, forceDialog: boolean, documentId: number) => ipcRenderer.invoke("smd:save", text, forceDialog, documentId),
  saveImage: (bytes: Uint8Array, ext: string, documentId: number) => ipcRenderer.invoke("smd:save-image", bytes, ext, documentId),
  exportPdf: (text: string, documentId: number) => ipcRenderer.invoke("smd:export-pdf", text, documentId),
  exportHtml: (text: string, documentId: number) => ipcRenderer.invoke("smd:export-html", text, documentId),
  print: (text: string, documentId: number) => ipcRenderer.invoke("smd:print", text, documentId),

  openDialog: () => ipcRenderer.invoke("smd:open-dialog"),
  openPath: (p: string, intent?: "peek" | "edit") => ipcRenderer.invoke("smd:open-path", p, intent),
  openLink: (href: string, intent?: "peek" | "edit") => ipcRenderer.invoke("smd:open-link", href, intent),
  setSettings: (patch: unknown) => ipcRenderer.invoke("smd:set-settings", patch),
  command: (cmd: string) => ipcRenderer.send("smd:command", cmd),
  hide: () => ipcRenderer.send("smd:hide"),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
});

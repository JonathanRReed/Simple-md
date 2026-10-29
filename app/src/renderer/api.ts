import { type RenderedHtml } from "../shared/render-tree.js";
import type { Command, DocPayload, FlushResult, RenderedBlock, Settings, SaveResult } from "../shared/types.js";

export interface Bridge {
  ready(): Promise<{ settings: Settings; platform: string }>;
  onDoc(cb: (doc: DocPayload) => void): void;
  onSaved(cb: (result: SaveResult) => void): void;
  onTransition(cb: (busy: boolean) => void): void;
  perfMarker(documentId: number, marker: string): void;
  documentReady(documentId: number): void;
  editing(documentId: number): void;
  acceptDisk(text: string, documentId: number): Promise<boolean>;
  onSettings(cb: (s: Settings) => void): void;
  onCommand(cb: (cmd: Command) => void): void;
  onDiskChanged(cb: (text: string, documentId: number, readOnlyReason?: string) => void): void;
  onFlushRequest(cb: (id: number) => void): void;
  onPrintDoc(cb: (doc: DocPayload, settings: Settings) => void): void;
  flushResponse(id: number, result: FlushResult): void;
  setDirty(dirty: boolean, documentId: number): void;
  printReady(error?: string): void;
  mdxRanges(text: string, documentId: number): Promise<import("../shared/render-core.js").MdxResult>;
  nextBlocks(stream: number, documentId: number): Promise<import("../shared/block-update.js").BlockUpdate>;
  renderBlocks(text: string, documentId: number): Promise<import("../shared/render-core.js").RenderedBlocks>;
  renderFragment(text: string, documentId: number): Promise<RenderedHtml>;
  save(text: string, forceDialog: boolean, documentId: number): Promise<SaveResult | null>;
  saveImage(bytes: Uint8Array, ext: string, documentId: number): Promise<string | null>;
  exportPdf(text: string, documentId: number): Promise<void>;
  exportHtml(text: string, documentId: number): Promise<void>;
  print(text: string, documentId: number): Promise<void>;
  openDialog(): Promise<void>;
  openPath(p: string, intent?: "peek" | "edit"): Promise<boolean>;
  openLink(href: string, intent?: "peek" | "edit"): Promise<boolean>;
  setSettings(patch: Partial<Settings>): Promise<void>;
  command(cmd: Command): void;
  hide(): void;
  pathForFile(f: File): string;
}

declare global {
  interface Window {
    simplemd: Bridge;
  }
}

export const bridge = (): Bridge => window.simplemd;

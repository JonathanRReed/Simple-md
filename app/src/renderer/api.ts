import { type RenderedHtml } from "../shared/render-tree.js";
import type { DocumentId, RevisionId, RequestId, Command, DocPayload, FlushResult, RenderedBlock, Settings, SaveResult } from "../shared/types.js";

export interface Bridge {
  ready(): Promise<{ settings: Settings; platform: string }>;
  onDoc(cb: (doc: DocPayload) => void): void;
  onSaved(cb: (result: SaveResult) => void): void;
  onTransition(cb: (busy: boolean) => void): void;
  perfMarker(documentId: DocumentId, marker: string): void;
  documentReady(documentId: DocumentId): void;
  edit(text: string, documentId: DocumentId, revisionId: RevisionId): void;
  editing(documentId: DocumentId): void;
  acceptDisk(text: string, documentId: DocumentId): Promise<boolean>;
  onSettings(cb: (s: Settings) => void): void;
  onCommand(cb: (cmd: Command) => void): void;
  onDiskChanged(cb: (text: string, documentId: DocumentId, readOnlyReason?: string) => void): void;
  onFlushRequest(cb: (id: RequestId, documentId: DocumentId) => void): void;
  onPrintDoc(cb: (doc: DocPayload, settings: Settings) => void): void;
  flushResponse(id: RequestId, result: FlushResult): void;
  setDirty(dirty: boolean, documentId: DocumentId): void;
  printReady(error?: string): void;
  mdxRanges(text: string, documentId: DocumentId, revisionId: RevisionId): Promise<import("../shared/render-core.js").MdxResult>;
  nextBlocks(stream: number, documentId: DocumentId): Promise<import("../shared/block-update.js").BlockUpdate>;
  renderBlocks(text: string, documentId: DocumentId, revisionId: RevisionId): Promise<import("../shared/render-core.js").RenderedBlocks>;
  renderFragment(text: string, documentId: DocumentId, revisionId: RevisionId): Promise<RenderedHtml>;
  save(text: string, forceDialog: boolean, documentId: DocumentId): Promise<SaveResult | null>;
  saveImage(bytes: Uint8Array, ext: string, documentId: DocumentId): Promise<string | null>;
  exportPdf(text: string, documentId: DocumentId): Promise<void>;
  exportHtml(text: string, documentId: DocumentId): Promise<void>;
  print(text: string, documentId: DocumentId): Promise<void>;
  openDialog(): Promise<void>;
  openPath(p: string, intent?: "read" | "edit"): Promise<boolean>;
  openLink(href: string, intent?: "read" | "edit"): Promise<boolean>;
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

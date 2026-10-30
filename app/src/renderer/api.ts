import type { HighlightState, GitChangesStatus } from "../shared/change-highlights.js";
import type { TabLayoutState } from "../shared/tab-layout.js";
import { type RenderedHtml } from "../shared/render-tree.js";
import type { DocumentId, PaneId, RevisionId, RequestId, Command, DocPayload, FlushResult, Settings, SaveResult } from "../shared/types.js";

export interface Bridge {
  readFindText(): Promise<string>;
  writeFindText(text: string): Promise<void>;
  onContextMenu(cb: (context: import("../shared/native-context.js").NativeContext) => void): void;
  contextMenu(context: import("../shared/native-context.js").NativeContext, id: DocumentId): Promise<import("../shared/native-context.js").ContextResult>;
  onLayout(cb: (layout: TabLayoutState) => void): void;
  onNavigate(cb: (id: DocumentId, target: import("../shared/types.js").DocumentLocation) => void): void;
  onClosed(cb: (id: DocumentId) => void): void;
  releaseView(id: DocumentId): void;
  activateTab(id: DocumentId): Promise<void>;
  paneMode(id: PaneId, mode: import("../shared/types.js").ViewMode): void;
  focusPane(id: PaneId): Promise<void>;
  closeTab(id: DocumentId): Promise<boolean>;
  ready(): Promise<{ settings: Settings; platform: string; accent: string }>;
  onDoc(cb: (doc: DocPayload) => void): void;
  onSaved(cb: (result: SaveResult) => void): void;
  onTransition(cb: (busy: boolean) => void): void;
  perfMarker(documentId: DocumentId, marker: string): void;
  documentReady(documentId: DocumentId): void;
  edit(text: string, documentId: DocumentId, revisionId: RevisionId): void;
  editing(documentId: DocumentId): void;
  acceptDisk(text: string, documentId: DocumentId, automatic?: boolean): Promise<boolean>;
  changes(documentId: DocumentId, revisionId: RevisionId): Promise<HighlightState>;
  markSeen(documentId: DocumentId, revisionId: RevisionId, watchOnly?: boolean): Promise<boolean>;
  gitStatus(documentId: DocumentId): Promise<GitChangesStatus>;
  headChanges(documentId: DocumentId, enabled: boolean): Promise<GitChangesStatus>;
  onSettings(cb: (s: Settings) => void): void;
  onCommand(cb: (cmd: Command, documentId?: DocumentId) => void): void;
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
  prepareDragExport(text: string, documentId: DocumentId, revisionId: RevisionId, format: "html" | "pdf"): Promise<{ token: string; name: string; expiresAt: number }>;
  startDragExport(documentId: DocumentId, revisionId: RevisionId, token: string): void;
  exportPdf(text: string, documentId: DocumentId): Promise<void>;
  exportHtml(text: string, documentId: DocumentId): Promise<void>;
  print(text: string, documentId: DocumentId): Promise<void>;
  openDialog(): Promise<void>;
  openPath(p: string, intent?: "read" | "edit", inPlace?: boolean, documentId?: DocumentId): Promise<boolean>;
  openLink(href: string, intent?: "read" | "edit", newTab?: boolean, documentId?: DocumentId): Promise<boolean>;
  setSettings(patch: Partial<Settings>): Promise<void>;
  command(cmd: Command, documentId?: DocumentId): void;
  hide(): void;
  pathForFile(f: File): string;
}

declare global {
  interface Window {
    simplemd: Bridge;
  }
}

export const bridge = (): Bridge => window.simplemd;

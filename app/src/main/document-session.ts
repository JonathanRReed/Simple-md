import { moveDocumentFile, type Destination } from "./file-actions.js";
import { FirstAutosave } from "../shared/first-autosave.js";
import type { ChangeBaseline, GitChangesStatus } from "../shared/change-highlights.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeRevisionId, type DiskChange, type DocumentId, type OpenIntent, type RevisionId, type SaveResult } from "../shared/types.js";
import { DocumentQueue } from "./lifecycle.js";
import { ENCODING_NOTICE, FileChangedDuringReadError, FileConflictError, readDocument, readDiskText, watchDocument, writeAtomic } from "./files.js";

export class DocumentSession {
  readonly firstAutosave: FirstAutosave;
  readonly saves = new DocumentQueue();
  suggestedFolder?: string;
  draftPath?: string;
  revisionId = makeRevisionId(0);
  baselinePath?: string;
  baseline: ChangeBaseline | null = null;
  baselineGeneration = 0;
  gitStatus: GitChangesStatus;
  conflict = false;
  dirty = false;
  unavailableReason: string | undefined;
  private watcher: { close(): void } | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchGeneration = 0;
  private disposed = false;
  private metadataWarningSent = false;
  private unavailableSequence = 0;
  private onDiskChanged: ((change: DiskChange) => void) | undefined;

  constructor(
    readonly documentId: DocumentId,
    public path: string | null,
    public text: string,
    public intent: OpenIntent = "edit",
    public readOnlyReason?: string,
    public diskText: string | null = path ? text : null,
    public displayName = "Untitled",
  ) {
    this.firstAutosave = new FirstAutosave(text, !!path && intent === "read");
    this.gitStatus = path ? { available: true, active: false } : { available: false, reason: "Save the file in a Git repository first." };
  }

  get name(): string { return this.path ? path.basename(this.path) : this.displayName; }
  get baseUrl(): string | null { return this.path ? pathToFileURL(path.dirname(this.path)).href.replace(/\/?$/, "/") : null; }
  get encoding(): "utf8" | "unsupported" { return this.readOnlyReason === ENCODING_NOTICE ? "unsupported" : "utf8"; }
  get lineEndings() {
    const counts = { lf: 0, crlf: 0, cr: 0 };
    for (const match of this.text.matchAll(/\r\n|\r|\n/g)) counts[match[0] === "\r\n" ? "crlf" : match[0] === "\r" ? "cr" : "lf"]++;
    return { ...counts, bom: this.text.startsWith("\uFEFF"), dominant: counts.crlf > counts.lf && counts.crlf > counts.cr ? "\r\n" : counts.cr > counts.lf && counts.cr > counts.crlf ? "\r" : "\n" };
  }

  edit(text: string, revisionId: RevisionId, deliberate = false): boolean {
    if (this.disposed || revisionId < this.revisionId || (revisionId === this.revisionId && text !== this.text)) return false;
    if (text === this.diskText) this.firstAutosave.baseline(text);
    else {
      if (deliberate) this.firstAutosave.confirm();
      this.firstAutosave.edit(text);
    }
    this.text = text;
    this.revisionId = revisionId;
    this.dirty = !!this.unavailableReason || text !== (this.diskText ?? "");
    return true;
  }

  isCurrent(revisionId: RevisionId): boolean { return !this.disposed && revisionId === this.revisionId; }

  /** A render result has authority only while its source revision is still current. */
  async render<T>(revisionId: RevisionId, prepare: () => Promise<T>): Promise<T> {
    if (!this.isCurrent(revisionId)) throw new Error("Stale document revision.");
    const result = await prepare();
    if (!this.isCurrent(revisionId)) throw new Error("Stale document revision.");
    return result;
  }

  watch(changed: (change: DiskChange) => void): void {
    this.stopWatching();
    this.onDiskChanged = changed;
    if (!this.path) return;
    const file = this.path;
    const generation = this.watchGeneration;
    let checkSequence = 0;
    const check = () => {
      clearTimeout(this.retryTimer);
      const sequence = ++checkSequence;
      void readDocument(file).then(({ text, readOnlyReason }) => {
        if (generation !== this.watchGeneration || sequence !== checkSequence) return;
        const permissionsChanged = readOnlyReason !== this.readOnlyReason;
        this.readOnlyReason = readOnlyReason;
        if (text === this.diskText && !this.unavailableReason) {
          if (permissionsChanged) changed({ kind: "permissions", readOnlyReason });
          return;
        }
        this.conflict = true;
        changed({ kind: "text", text, readOnlyReason });
      }).catch((err) => {
        if (generation !== this.watchGeneration || sequence !== checkSequence) return;
        // Another program is still writing. The file is there, so look again once it has had time to finish.
        if (err instanceof FileChangedDuringReadError) this.retryTimer = setTimeout(check, 250);
        else this.unavailable(err);
      });
    };
    try { this.watcher = watchDocument(file, check); check(); }
    catch (err) { console.error("simple-md: could not watch note", err); }
  }

  private unavailable(error: unknown): void {
    const missing = error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code));
    this.unavailableSequence++;
    this.unavailableReason = missing ? "This file is missing or was moved." : "This file could not be read.";
    this.conflict = true;
    this.dirty = true;
    if (this.readOnlyReason !== ENCODING_NOTICE) this.readOnlyReason = undefined;
    this.onDiskChanged?.({ kind: "unavailable", message: this.unavailableReason, readOnlyReason: this.readOnlyReason });
  }

  markSeen(): void { this.baselinePath = undefined; this.baseline = null; this.baselineGeneration++; }

  setHeadBaseline(text: string): void { this.baselinePath ??= this.path ?? undefined; this.baseline = { kind: "head", text }; this.baselineGeneration++; }

  async acceptDisk(text: string, highlight = false): Promise<boolean> {
    if (!this.path) return false;
    const latest = await readDocument(this.path).catch((err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
      throw err;
    });
    if (!latest || latest.text !== text) return false;
    if (highlight && !this.dirty && !this.baseline && text !== this.text && !latest.readOnlyReason) {
      this.baseline = { kind: "watch", text: this.text };
      this.baselineGeneration++;
    }
    this.diskText = text;
    this.unavailableReason = undefined;
    this.conflict = false;
    this.readOnlyReason = latest.readOnlyReason;
    return true;
  }

  save(target: string, revisionId: RevisionId, force = false, recreate = false): Promise<SaveResult | null> {
    return this.saves.run(async () => {
      if (!this.isCurrent(revisionId) || this.readOnlyReason || (this.conflict && !force && !recreate)) return null;
      if (recreate && (target !== this.path || !this.unavailableReason)) return null;
      const text = this.text;
      const unavailableSequence = this.unavailableSequence;
      let metadataCopyFailed: boolean;
      try {
        const expected = recreate || target === this.draftPath && !force ? null : target === this.path ? this.diskText : await readDiskText(target);
        ({ metadataCopyFailed } = await writeAtomic(target, text, expected));
      } catch (err) {
        if (target !== this.path) throw err;
        const racing = (error: unknown) => error instanceof FileChangedDuringReadError;
        const external = await readDocument(target).catch((error: unknown) => {
          // A file that is mid-write is a conflict, not a missing file. The watcher delivers its text once it settles.
          if (racing(error)) this.conflict = true;
          else this.unavailable(error);
          return null;
        });
        if (!external) return null;
        if (!(err instanceof FileConflictError) && !racing(err)) throw err;
        this.conflict = true;
        this.onDiskChanged?.({ kind: "text", ...external });
        return null;
      }
      const moved = target !== this.path;
      if (moved) {
        this.markSeen();
        this.gitStatus = { available: true, active: false };
      }
      this.path = target;
      this.draftPath = undefined;
      this.firstAutosave.confirm();
      this.diskText = text;
      if (moved || unavailableSequence === this.unavailableSequence) this.unavailableReason = undefined;
      this.conflict = !!this.unavailableReason;
      this.dirty = !!this.unavailableReason || this.text !== text;
      if (moved && this.onDiskChanged) this.watch(this.onDiskChanged);
      const showMetadataWarning = metadataCopyFailed && !this.metadataWarningSent;
      if (metadataCopyFailed) this.metadataWarningSent = true;
      return { documentId: this.documentId, revisionId, path: target, name: this.name, baseUrl: this.baseUrl!, text, metadataCopyFailed, showMetadataWarning, unavailableReason: this.unavailableReason };
    });
  }

  move(target: string, expected: Destination): Promise<SaveResult | null> {
    return this.saves.run(async () => {
      if (!this.path || this.dirty || this.conflict || this.unavailableReason) return null;
      const previous = this.path;
      this.stopWatching();
      try {
        await moveDocumentFile(previous, target, this.text, expected);
        this.path = target;
        return { moved: true, documentId: this.documentId, revisionId: this.revisionId, path: target, name: this.name, baseUrl: this.baseUrl!, text: this.text };
      } finally { if (this.onDiskChanged) this.watch(this.onDiskChanged); }
    });
  }

  stopWatching(): void { this.watchGeneration++; clearTimeout(this.retryTimer); this.watcher?.close(); this.watcher = undefined; }
  dispose(): void { this.disposed = true; this.markSeen(); this.stopWatching(); }
}

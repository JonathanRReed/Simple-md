import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeRevisionId, type DocumentId, type OpenIntent, type RevisionId, type SaveResult } from "../shared/types.js";
import { DocumentQueue } from "./lifecycle.js";
import { ENCODING_NOTICE, FileConflictError, readDocument, readDiskText, watchDocument, writeAtomic } from "./files.js";

export class DocumentSession {
  readonly saves = new DocumentQueue();
  revisionId = makeRevisionId(0);
  conflict = false;
  dirty = false;
  private watcher: { close(): void } | undefined;
  private watchGeneration = 0;
  private disposed = false;
  private onDiskChanged: ((text: string, reason?: string) => void) | undefined;

  constructor(
    readonly documentId: DocumentId,
    public path: string | null,
    public text: string,
    public intent: OpenIntent = "edit",
    public readOnlyReason?: string,
    public diskText: string | null = path ? text : null,
    public displayName = "Untitled",
  ) {}

  get name(): string { return this.path ? path.basename(this.path) : this.displayName; }
  get baseUrl(): string | null { return this.path ? pathToFileURL(path.dirname(this.path)).href.replace(/\/?$/, "/") : null; }
  get encoding(): "utf8" | "unsupported" { return this.readOnlyReason === ENCODING_NOTICE ? "unsupported" : "utf8"; }
  get lineEndings() {
    const counts = { lf: 0, crlf: 0, cr: 0 };
    for (const match of this.text.matchAll(/\r\n|\r|\n/g)) counts[match[0] === "\r\n" ? "crlf" : match[0] === "\r" ? "cr" : "lf"]++;
    return { ...counts, bom: this.text.startsWith("\uFEFF"), dominant: counts.crlf > counts.lf && counts.crlf > counts.cr ? "\r\n" : counts.cr > counts.lf && counts.cr > counts.crlf ? "\r" : "\n" };
  }

  edit(text: string, revisionId: RevisionId): boolean {
    if (this.disposed || revisionId < this.revisionId || (revisionId === this.revisionId && text !== this.text)) return false;
    this.text = text;
    this.revisionId = revisionId;
    this.dirty = text !== (this.diskText ?? "");
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

  watch(changed: (text: string, reason?: string) => void): void {
    this.stopWatching();
    this.onDiskChanged = changed;
    if (!this.path) return;
    const file = this.path;
    const generation = this.watchGeneration;
    const check = () => {
      void readDocument(file).then(({ text, readOnlyReason }) => {
        if (generation !== this.watchGeneration) return;
        if (readOnlyReason) this.readOnlyReason = readOnlyReason;
        if (!readOnlyReason && text === this.diskText) return;
        this.conflict = true;
        changed(text, readOnlyReason);
      }).catch((err) => console.error("simple-md: could not read changed note", err));
    };
    try { this.watcher = watchDocument(file, check); check(); }
    catch (err) { console.error("simple-md: could not watch note", err); }
  }

  async acceptDisk(text: string): Promise<boolean> {
    if (!this.path) return false;
    const latest = await readDocument(this.path).catch((err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
      throw err;
    });
    if (!latest || latest.text !== text) return false;
    this.diskText = text;
    this.conflict = false;
    this.readOnlyReason = latest.readOnlyReason;
    return true;
  }

  save(target: string, revisionId: RevisionId, force = false): Promise<SaveResult | null> {
    return this.saves.run(async () => {
      if (!this.isCurrent(revisionId) || this.readOnlyReason || (this.conflict && !force)) return null;
      const text = this.text;
      try {
        const expected = target === this.path ? this.diskText : await readDiskText(target);
        await writeAtomic(target, text, expected);
      } catch (err) {
        if (!(err instanceof FileConflictError)) throw err;
        this.conflict = true;
        const external = await readDiskText(target).catch(() => null);
        if (external !== null) this.onDiskChanged?.(external);
        return null;
      }
      const moved = target !== this.path;
      this.path = target;
      this.diskText = text;
      this.conflict = false;
      this.dirty = this.text !== text;
      if (moved && this.onDiskChanged) this.watch(this.onDiskChanged);
      return { documentId: this.documentId, revisionId, path: target, name: this.name, baseUrl: this.baseUrl!, text };
    });
  }

  stopWatching(): void { this.watchGeneration++; this.watcher?.close(); this.watcher = undefined; }
  dispose(): void { this.disposed = true; this.stopWatching(); }
}

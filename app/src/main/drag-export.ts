import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DocumentId, RevisionId } from "../shared/types.js";

export type ExportFormat = "html" | "pdf";
interface PreparedExport {
  documentId: DocumentId;
  revisionId: RevisionId;
  file: string;
  directory: string;
  timer: ReturnType<typeof setTimeout>;
}
/** Files outlive the drag because destinations may copy them after startDrag returns. */
export class DragExports {
  private readonly files = new Map<string, PreparedExport>();
  private closed = false;
  constructor(private readonly retentionMs = 10 * 60 * 1000) {}

  async prepare(documentId: DocumentId, revisionId: RevisionId, name: string, format: ExportFormat, create: () => Promise<Uint8Array>) {
    if (this.closed) throw new Error("Exports are closed.");
    const bytes = await create();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "simplemd-export-"));
    try {
      const filename = `${(path.basename(name).replace(/\.[^.]*$/, "").replace(/[\\/:\x00-\x1f]/g, "_") || "Untitled").slice(0, 120)}.${format}`;
      const file = path.join(directory, filename);
      await fs.writeFile(file, bytes, { mode: 0o600 });
      if (this.closed) throw new Error("Exports are closed.");
      const token = randomUUID();
      const entry: PreparedExport = { documentId, revisionId, file, directory, timer: setTimeout(() => void this.remove(token), this.retentionMs) };
      entry.timer.unref();
      this.files.set(token, entry);
      return { token, name: filename, expiresAt: Date.now() + this.retentionMs };
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  }

  take(token: string, documentId: DocumentId, revisionId: RevisionId): string {
    const entry = this.files.get(token);
    if (!entry || entry.documentId !== documentId || entry.revisionId !== revisionId) throw new Error("Prepare this document's current export before dragging.");
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.remove(token), this.retentionMs);
    entry.timer.unref();
    return entry.file;
  }

  private async remove(token: string): Promise<void> {
    const entry = this.files.get(token);
    if (!entry) return;
    this.files.delete(token);
    clearTimeout(entry.timer);
    await fs.rm(entry.directory, { recursive: true, force: true });
  }
  async dispose(): Promise<void> { this.closed = true; await Promise.all([...this.files.keys()].map(token => this.remove(token))); }
}

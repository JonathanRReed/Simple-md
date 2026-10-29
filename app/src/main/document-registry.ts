import { makeDocumentId, type DocumentId, type OpenIntent } from "../shared/types.js";
import { DocumentSession } from "./document-session.js";

/** Sessions being prepared coexist with the visible document until opening succeeds. */
export class DocumentRegistry {
  private readonly sessions = new Map<DocumentId, DocumentSession>();
  private nextId = 0;
  constructor(private readonly removed?: (id: DocumentId) => void) {}

  create(file: string | null, text: string, intent: OpenIntent = "edit", reason?: string): DocumentSession {
    const session = new DocumentSession(makeDocumentId(this.nextId++), file, text, intent, reason);
    this.sessions.set(session.documentId, session);
    return session;
  }
  get(id: DocumentId): DocumentSession | undefined { return this.sessions.get(id); }
  remove(id: DocumentId): void { this.sessions.get(id)?.dispose(); this.sessions.delete(id); this.removed?.(id); }
  dispose(): void { for (const session of this.sessions.values()) session.dispose(); this.sessions.clear(); }
}

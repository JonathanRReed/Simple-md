import type { DocumentId, FlushResult } from "../shared/types.js";

export class DocumentQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

export async function openPreparedDocument<T>(a: {
  prepare(): Promise<T>;
  transition(operation: () => Promise<boolean>): Promise<boolean>;
  settle(): Promise<boolean>;
  refresh(prepared: T): Promise<T>;
  present(prepared: T): Promise<void>;
}): Promise<boolean> {
  const prepared = await a.prepare();
  return a.transition(async () => {
    if (!(await a.settle())) return false;
    const refreshed = await a.refresh(prepared);
    await a.present(refreshed);
    return true;
  });
}

interface SettleActions {
  documentId: DocumentId;
  autosave: boolean | (() => boolean);
  hasPath: boolean;
  flush(): Promise<FlushResult | null>;
  save(text: string): Promise<boolean>;
  choose(): Promise<"save" | "discard" | "cancel">;
  resolveUnavailable?(): Promise<"saved" | "discard" | "cancel">;
}

export async function settleDocument(a: SettleActions): Promise<boolean> {
  const before = await a.flush();
  if (!before || before.documentId !== a.documentId) return false;
  const resolveUnavailable = async (buffer: FlushResult): Promise<boolean> => {
    const choice = await a.resolveUnavailable?.() ?? "cancel";
    if (choice === "cancel") return false;
    const after = await a.flush();
    return after !== null && after.documentId === a.documentId && after.text === buffer.text &&
      (choice === "discard" || (!after.dirty && !after.conflict && !after.unavailable));
  };
  if (before.unavailable) return resolveUnavailable(before);
  if (before.conflict) return false;
  if (!before.dirty) return true;
  const autosave = typeof a.autosave === "function" ? a.autosave() : a.autosave;
  const choice = autosave && a.hasPath ? "save" : await a.choose();
  if (choice === "cancel") return false;
  if (choice === "save" && !(await a.save(before.text))) {
    const failed = await a.flush();
    if (failed?.documentId === a.documentId && failed.unavailable) return resolveUnavailable(failed);
    return false;
  }
  const after = await a.flush();
  return after !== null && after.documentId === a.documentId && after.text === before.text &&
    !after.conflict && (choice === "discard" || !after.dirty);
}

export async function quitAfterSettle(a: {
  settle(): Promise<boolean>;
  cleanup(): Promise<void>;
  exit(): void;
  cancel?(): void;
}): Promise<boolean> {
  let completed = false;
  try {
    if (!(await a.settle())) return false;
    await a.cleanup();
    a.exit();
    completed = true;
    return true;
  } finally { if (!completed) a.cancel?.(); }
}

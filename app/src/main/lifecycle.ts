import type { FlushResult } from "../shared/types.js";

export class DocumentQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

export async function openPreparedDocument<T>(a: {
  valid(): Promise<boolean>;
  prepare(): Promise<T>;
  transition(operation: () => Promise<boolean>): Promise<boolean>;
  settle(): Promise<boolean>;
  refresh(prepared: T): Promise<T>;
  present(prepared: T): Promise<void>;
}): Promise<boolean> {
  if (!(await a.valid())) return false;
  const prepared = await a.prepare();
  return a.transition(async () => {
    if (!(await a.valid()) || !(await a.settle())) return false;
    const refreshed = await a.refresh(prepared);
    if (!(await a.valid())) return false;
    await a.present(refreshed);
    return true;
  });
}

interface SettleActions {
  documentId: number;
  autosave: boolean;
  hasPath: boolean;
  flush(): Promise<FlushResult | null>;
  save(text: string): Promise<boolean>;
  choose(): Promise<"save" | "discard" | "cancel">;
}

export async function settleDocument(a: SettleActions): Promise<boolean> {
  const before = await a.flush();
  if (!before || before.documentId !== a.documentId) return false;
  if (before.conflict) return false;
  if (!before.dirty) return true;
  const choice = a.autosave && a.hasPath ? "save" : await a.choose();
  if (choice === "cancel") return false;
  if (choice === "save" && !(await a.save(before.text))) return false;
  const after = await a.flush();
  return after !== null && after.documentId === a.documentId && after.text === before.text &&
    !after.conflict && (choice === "discard" || !after.dirty);
}

export async function quitAfterSettle(a: {
  settle(): Promise<boolean>;
  cleanup(): Promise<void>;
  exit(): void;
}): Promise<boolean> {
  if (!(await a.settle())) return false;
  await a.cleanup();
  a.exit();
  return true;
}

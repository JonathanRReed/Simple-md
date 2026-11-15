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
  allowDiscard?: boolean;
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
    if (choice === "cancel" || choice === "discard" && a.allowDiscard === false) return false;
    const after = await a.flush();
    return after !== null && after.documentId === a.documentId && after.text === buffer.text &&
      (choice === "discard" || (!after.dirty && !after.conflict && !after.unavailable));
  };
  if (before.unavailable) return resolveUnavailable(before);
  if (before.conflict) return false;
  if (!before.dirty) return true;
  const autosave = typeof a.autosave === "function" ? a.autosave() : a.autosave;
  const choice = autosave && a.hasPath ? "save" : await a.choose();
  if (choice === "cancel" || choice === "discard" && a.allowDiscard === false) return false;
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

interface QuitWindow { quitFrozen?: boolean }
export function releaseQuitWindows<T extends QuitWindow>(windows: Iterable<T>, busy: (host: T, value: boolean) => void): void {
  for (const host of windows) { host.quitFrozen = false; busy(host, false); }
}
export async function settleAllWindows<T extends QuitWindow>(windows: Iterable<T>, busy: (host: T, value: boolean) => void, settle: (host: T) => Promise<boolean>): Promise<boolean> {
  const hosts = [...windows];
  for (const host of hosts) { host.quitFrozen = true; busy(host, true); }
  for (const host of hosts) if (!await settle(host)) return false;
  return true;
}
export function canOpenWindow(windows: Iterable<QuitWindow>): boolean {
  return ![...windows].some(host => host.quitFrozen);
}
export async function prepareQuit(actions: {
  starting?: Promise<void>;
  disposeExports(): Promise<void>;
  closeWaiters(): void;
  transport(): { drain(): Promise<void>; close(): void } | undefined;
  disposeRenderer(): Promise<void>;
  finish(): void;
}): Promise<void> {
  await actions.starting;
  await actions.disposeExports();
  actions.closeWaiters();
  const transport = actions.transport();
  await transport?.drain();
  transport?.close();
  await actions.disposeRenderer();
  actions.finish();
}

export function saveChangesPrompt(name: string, preserve: "move" | "share" | false = false) {
  return {
    type: "warning" as const,
    message: preserve ? `Save “${name}” before ${preserve === "move" ? "moving" : "sharing"}?` : `Save changes to “${name}”?`,
    detail: preserve ? "" : "Your changes will be lost if you don't save them.",
    buttons: preserve ? ["Save", "Cancel"] : ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: preserve ? 1 : 2,
  };
}

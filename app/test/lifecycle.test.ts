import { expect, test } from "bun:test";
import { DocumentQueue, openPreparedDocument, settleDocument } from "../src/main/lifecycle";
import { makeDocumentId, makeRevisionId, type FlushResult } from "../src/shared/types";

function actions(flushes: (FlushResult | null)[]) {
  return {
    documentId: makeDocumentId(4), autosave: true, hasPath: true,
    flush: async () => flushes.shift() ?? null,
    save: async (_text: string) => true,
    choose: async () => "cancel" as const,
  };
}
const dirty = { revisionId: makeRevisionId(0), documentId: makeDocumentId(4), conflict: false, dirty: true, text: "local edits" };

test("missing or stale flush never authorizes replacing a document", async () => {
  expect(await settleDocument(actions([null]))).toBe(false);
  expect(await settleDocument(actions([{ ...dirty, documentId: makeDocumentId(3), dirty: false }]))).toBe(false);
});

test("failed autosave blocks closing and opening another note", async () => {
  const a = actions([dirty]);
  a.save = async () => false;
  expect(await settleDocument(a)).toBe(false);
});

test("edits entered while saving block the original transition", async () => {
  expect(await settleDocument(actions([dirty, { ...dirty, text: "newer edit" }]))).toBe(false);
  expect(await settleDocument(actions([dirty, { ...dirty, dirty: false }]))).toBe(true);
});

test("new edits during a discard dialog are not discarded", async () => {
  const a = { ...actions([dirty, { ...dirty, text: "typed in dialog" }]), autosave: false, choose: async () => "discard" as const };
  expect(await settleDocument(a)).toBe(false);
});

test("document operations run in request order even when one fails", async () => {
  const queue = new DocumentQueue();
  const events: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run(async () => { events.push("open-start"); await gate; events.push("open-end"); });
  const second = queue.run(async () => { events.push("save"); throw new Error("disk full"); });
  const handled = second.catch(() => {});
  const third = queue.run(async () => { events.push("next-open"); });
  await Promise.resolve();
  expect(events).toEqual(["open-start"]);
  release();
  await Promise.all([first, handled, third]);
  expect(events).toEqual(["open-start", "open-end", "save", "next-open"]);
});

test("a missing post-save acknowledgement blocks the transition", async () => {
  expect(await settleDocument(actions([dirty, null]))).toBe(false);
});

test("a clean document needs no save or discard dialog", async () => {
  const a = actions([{ ...dirty, dirty: false }]);
  a.save = async () => { throw new Error("Unexpected save"); };
  a.choose = async () => { throw new Error("Unexpected dialog"); };
  expect(await settleDocument(a)).toBe(true);
});

test("acknowledged external B cannot be overwritten by C while the renderer conflict is unresolved", async () => {
  let disk = "B";
  const editor = "C";
  let saves = 0;
  const a = actions([{ ...dirty, text: editor, conflict: true }]);
  a.save = async (text) => { saves++; disk = text; return true; };
  expect(await settleDocument(a)).toBe(false);
  expect(disk).toBe("B");
  expect(editor).toBe("C");
  expect(saves).toBe(0);
});

test("a conflict arriving during save or discard blocks a transition", async () => {
  expect(await settleDocument(actions([dirty, { ...dirty, dirty: false, conflict: true }]))).toBe(false);
  expect(await settleDocument(actions([{ ...dirty, dirty: false, conflict: true }]))).toBe(false);
});

test("menu quit preserves the document on failed settle and waits for cleanup before exiting", async () => {
  const { quitAfterSettle } = await import("../src/main/lifecycle");
  const events: string[] = [];
  const a = {
    settle: async () => false,
    cleanup: async () => { events.push("cleanup"); },
    exit: () => { events.push("exit"); },
  };
  expect(await quitAfterSettle(a)).toBe(false);
  expect(events).toEqual([]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  a.settle = async () => true;
  a.cleanup = async () => { events.push("cleanup"); await gate; events.push("worker stopped"); };
  const quit = quitAfterSettle(a);
  await Promise.resolve();
  expect(events).toEqual(["cleanup"]);
  release();
  expect(await quit).toBe(true);
  expect(events).toEqual(["cleanup", "worker stopped", "exit"]);
});

test("the delayed disk acknowledgement conflict preserves real B bytes and local C on close and navigation", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { writeAtomic } = await import("../src/main/files");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-conflict-"));
  const file = path.join(dir, "note.md");
  try {
    await fs.writeFile(file, "A");
    await fs.writeFile(file, "B");
    const acknowledgedDisk = await fs.readFile(file, "utf8");
    const localText = "C";
    for (const _intent of ["close", "navigate"]) {
      const a = actions([{ ...dirty, text: localText, conflict: true }]);
      a.save = async (text) => { await writeAtomic(file, text, acknowledgedDisk); return true; };
      expect(await settleDocument(a)).toBe(false);
      expect(await fs.readFile(file, "utf8")).toBe("B");
      expect(localText).toBe("C");
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("normal opens settle before refresh and present the refreshed disk payload", async () => {
  const events: string[] = [];
  let canSettle = false;
  const a = {
    prepare: async () => { events.push("prepare"); return "before"; },
    transition: async (operation: () => Promise<boolean>) => operation(),
    settle: async () => { events.push("settle"); return canSettle; },
    refresh: async (_prepared: string) => { events.push("refresh"); return "after"; },
    present: async (prepared: string) => { events.push(`present ${prepared}`); },
  };
  expect(await openPreparedDocument(a)).toBe(false);
  expect(events).toEqual(["prepare", "settle"]);
  events.length = 0;
  canSettle = true;
  expect(await openPreparedDocument(a)).toBe(true);
  expect(events).toEqual(["prepare", "settle", "refresh", "present after"]);
});

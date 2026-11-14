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

for (const choice of ["saved", "discard", "cancel"] as const) test(`missing files offer recovery before closing: ${choice}`, async () => {
  const missing = { ...dirty, unavailable: true, conflict: true };
  let offered = 0;
  const a = { ...actions([missing, choice === "saved" ? { ...dirty, dirty: false } : missing]),
    resolveUnavailable: async () => { offered++; return choice; } };
  expect(await settleDocument(a)).toBe(choice !== "cancel");
  expect(offered).toBe(1);
});
test("deletion discovered during autosave offers recovery instead of silently refusing quit", async () => {
  let offered = false;
  const missing = { ...dirty, unavailable: true, conflict: true };
  const a = { ...actions([dirty, missing, missing]), save: async () => false,
    resolveUnavailable: async () => { offered = true; return "discard" as const; } };
  expect(await settleDocument(a)).toBe(true); expect(offered).toBe(true);
});
test("edits entered during missing-file recovery block discard", async () => {
  const missing = { ...dirty, unavailable: true, conflict: true };
  let offered = false;
  const a = { ...actions([missing, { ...missing, text: "new typing" }]), resolveUnavailable: async () => { offered = true; return "discard" as const; } };
  expect(await settleDocument(a)).toBe(false); expect(offered).toBe(true);
});


test("Share and Move settle current bytes and stop when saving is cancelled or declined", async () => {
  const documentId = makeDocumentId(0);
  for (const choice of ["discard", "cancel"] as const) {
    let saves = 0;
    const result = await settleDocument({ documentId, autosave: false, hasPath: true, allowDiscard: false,
      flush: async () => ({ documentId, revisionId: makeRevisionId(0), dirty: true, conflict: false, text: "current edits" }),
      choose: async () => choice, save: async () => { saves++; return true; },
    });
    expect(result).toBe(false); expect(saves).toBe(0);
  }
  let dirty = true, saved: string | undefined;
  expect(await settleDocument({ documentId, autosave: true, hasPath: true, allowDiscard: false,
    flush: async () => ({ documentId, revisionId: makeRevisionId(0), dirty, conflict: false, text: "current edits\r\n" }),
    choose: async () => "cancel", save: async text => { saved = text; dirty = false; return true; },
  })).toBe(true);
  expect(saved).toBe("current edits\r\n");
});

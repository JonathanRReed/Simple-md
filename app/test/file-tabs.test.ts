import { expect, test } from "bun:test";
import path from "node:path";
import { ClosedTabs, closeTabs, tabsToClose } from "../src/shared/closed-tabs";
import { makeDocumentId } from "../src/shared/types";
import { fileArgs, OpenRequests } from "../src/main/open-requests";
import { parseCliRequest, parseOpenUrl } from "../src/main/cli-protocol";
import { cliOpenTarget, openCliBatch } from "../src/main/cli-open";
import { DocumentRegistry } from "../src/main/document-registry";
import fs from "node:fs/promises";
import os from "node:os";
const ids = [0, 1, 2, 3, 4].map(makeDocumentId);
test("closed tabs keep only saved paths, in session-only last-closed order", () => {
  const closed = new ClosedTabs(); closed.add(null); closed.add("/a.md"); closed.add("/b.mdx");
  expect(closed.size).toBe(2); expect(closed.take()).toBe("/b.mdx"); expect(closed.take()).toBe("/a.md"); expect(closed.take()).toBeUndefined(); expect(new ClosedTabs().size).toBe(0);
});
test("group close protects pins, respects strip order and stops on cancellation", async () => {
  expect(tabsToClose(ids, [ids[3]!], ids[1]!, true)).toEqual([ids[2]!, ids[4]!]);
  expect(tabsToClose(ids, [ids[0]!, ids[3]!], ids[1]!, false)).toEqual([ids[2]!, ids[4]!]);
  expect(tabsToClose(ids, [], makeDocumentId(999), false)).toEqual([]);
  const closed: number[] = []; await closeTabs(ids, async id => { closed.push(id); return id !== ids[1]; }); expect(closed).toEqual([0, 1]);
});
test("argv opens every supported positional file and ignores options, URLs and directories", () => {
  const args = ["app", "/app", "--background", "a.md", "b.mdx", "COMMIT_EDITMSG", "simplemd://open?path=/x.md", "image.png", "--", "-draft.md"];
  expect(fileArgs(args, "/work", file => path.basename(file) !== "app")).toEqual(["a.md", "b.mdx", "COMMIT_EDITMSG", "-draft.md"].map(file => path.resolve("/work", file)));
});
test("native file requests preserve pre-ready events and events arriving during drain", async () => {
  const seen: string[] = [];
  const queue = new OpenRequests(async file => { seen.push(file); if (file === "a.md") queue.add(["c.md"]); });
  queue.add(["a.md"]); queue.add(["b.md"]); expect(seen).toEqual([]); expect(queue.size).toBe(2);
  await queue.start(); expect(seen).toEqual(["a.md", "b.md", "c.md"]);
});
test("failed native open does not prevent subsequent files from opening", async () => {
  const seen: string[] = [], failures: unknown[] = [];
  const queue = new OpenRequests(async file => { seen.push(file); if (file === "bad") throw new Error("missing"); }, error => { failures.push(error); });
  queue.add(["a", "bad", "b"]); await queue.start(); expect(seen).toEqual(["a", "bad", "b"]); expect(failures).toHaveLength(1);
});
test("CLI batch protocol validates each location, creation flag and request size", () => {
  const secret = "a".repeat(64), file = path.resolve("note.md");
  const request = { version: 1, id: "batch", secret, command: "open-many", wait: true, files: [{ path: file, line: 12, create: true }, { path: path.resolve("b.mdx"), heading: "hello", create: true }] };
  expect(parseCliRequest(request, secret, 200)).toMatchObject({ command: "open-many", wait: true, files: [{ path: file, location: { kind: "line", line: 12 }, create: true }, { location: { kind: "heading", heading: "hello" } }] });
  for (const files of [[], [{ path: "relative.md" }], [{ path: file, create: "yes" }], [{ path: file, line: 1, heading: "x" }]]) expect(() => parseCliRequest({ ...request, files }, secret, 200)).toThrow();
  expect(() => parseOpenUrl(`simplemd://open?path=${encodeURIComponent(file)}&create=true`)).toThrow();
});
test("CLI missing-file drafts write nothing, save to their bound path and reject an intervening file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-drafts-")), file = path.join(dir, "new.mdx"), registry = new DocumentRegistry();
  try {
    await expect(cliOpenTarget(file, false)).rejects.toThrow();
    const target = await cliOpenTarget(file, true); expect(target.kind).toBe("draft");
    expect(await fs.readdir(dir)).toEqual([]);
    await expect(cliOpenTarget(path.join(dir, "missing/note.md"), true)).rejects.toThrow();
    await expect(cliOpenTarget(dir, true)).rejects.toThrow("regular files");
    const doc = registry.create(null, "draft\r\n"); doc.draftPath = target.path;
    await fs.writeFile(file, "arrived later");
    await expect(doc.save(target.path, doc.revisionId)).rejects.toThrow(); expect(doc.path).toBeNull(); expect(doc.text).toBe("draft\r\n"); expect(await fs.readFile(file, "utf8")).toBe("arrived later");
    await fs.unlink(file); expect((await doc.save(target.path, doc.revisionId))?.path).toBe(target.path); expect(await fs.readFile(file, "utf8")).toBe("draft\r\n"); expect(doc.draftPath).toBeUndefined();
  } finally { registry.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("a CLI batch waits for every document, including duplicate paths, and detaches all waiters on failure", async () => {
  const callbacks: (() => void)[] = []; let completed = 0, removed = 0;
  const cleanup = await openCliBatch(["a", "b", "a"], async (_file, closed) => { callbacks.push(closed); return () => { removed++; }; }, () => { completed++; });
  callbacks[0]!(); callbacks[1]!(); expect(completed).toBe(0); callbacks[2]!(); expect(completed).toBe(1);
  cleanup(); expect(removed).toBe(3);
  const opened: string[] = [];
  await expect(openCliBatch(["a", "bad", "b"], async file => { opened.push(file); if (file === "bad") throw new Error("bad path"); return () => { removed++; }; }, () => {})).rejects.toThrow("bad path");
  expect(opened).toEqual(["a", "bad", "b"]); expect(removed).toBe(5);
});
test("a batch closed during acceptance still sends exactly one final close", async () => {
  let closed = 0;
  await openCliBatch(["a", "b"], async (_file, done) => { done(); return () => {}; }, () => { closed++; });
  expect(closed).toBe(1);
});

import { expect, test } from "bun:test";
import { PeekSession } from "../src/main/peek-request";
import { DocumentQueue, openPreparedDocument } from "../src/main/lifecycle";

test("callbacks from dead H1 cannot consume H2 request with reused ID 1", async () => {
  const h1Commands: unknown[] = [];
  const h2Commands: unknown[] = [];
  const h1 = new PeekSession((command) => { h1Commands.push(command); return true; });
  const old = h1.request(1, ["A.md"])!;
  const waiting = old.validate();
  h1.close();
  expect(await waiting).toBe(false);
  const h2 = new PeekSession((command) => { h2Commands.push(command); return true; });
  const fresh = h2.request(1, ["B.md"])!;
  old.replay();
  old.complete();
  expect(await old.validate()).toBe(false);
  expect(h2Commands).toEqual([]);
  expect(h1Commands).toEqual([{ cmd: "validate-peek", requestId: 1 }]);
  let freshResolved = false;
  const valid = fresh.validate().then((value) => { freshResolved = true; return value; });
  h1.validation(1, true);
  await Promise.resolve();
  expect(freshResolved).toBe(false);
  h2.validation(1, true);
  expect(await valid).toBe(true);
  fresh.replay();
  fresh.complete();
  fresh.complete();
  expect(h2Commands).toEqual([
    { cmd: "validate-peek", requestId: 1 }, { cmd: "replay-space", requestId: 1 }, { cmd: "complete-peek", requestId: 1 },
  ]);
});

test("validation timeout cancels opening but permits same-child replay then completion", async () => {
  const commands: unknown[] = [];
  const session = new PeekSession((command) => { commands.push(command); return true; }, 10);
  const request = session.request(1, ["A.md"])!;
  expect(await request.validate()).toBe(false);
  session.validation(1, true);
  expect(await request.validate()).toBe(false);
  request.replay();
  request.replay();
  request.complete();
  expect(commands).toEqual([
    { cmd: "validate-peek", requestId: 1 }, { cmd: "replay-space", requestId: 1 }, { cmd: "complete-peek", requestId: 1 },
  ]);
});

test("completion invalidates outstanding validators and dead transports cannot authorize", async () => {
  const session = new PeekSession(() => true);
  const request = session.request(1, ["A.md"])!;
  const validation = request.validate();
  request.complete();
  expect(await validation).toBe(false);
  session.validation(1, true);
  expect(await request.validate()).toBe(false);
  const dead = new PeekSession(() => false);
  expect(await dead.request(1, ["B.md"])!.validate()).toBe(false);
});

function openActions() {
  const events: string[] = [];
  let live = true;
  return {
    events,
    invalidate() { live = false; },
    valid: async () => { events.push("validate"); return live; },
    prepare: async () => { events.push("render"); return "A.md"; },
    transition: async (operation: () => Promise<boolean>) => operation(),
    settle: async () => { events.push("settle"); return true; },
    refresh: async (file: string) => { events.push("refresh"); return file; },
    present: async (_file: string) => { events.push("reveal"); },
  };
}

test("a peek that expires while queued never reads, settles or reveals", async () => {
  const queue = new DocumentQueue();
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => { release = done; });
  const previous = queue.run(() => gate);
  const a = openActions();
  const peek = queue.run(() => openPreparedDocument(a));
  a.invalidate();
  release();
  await previous;
  expect(await peek).toBe(false);
  expect(a.events).toEqual(["validate"]);
});

test("selection or focus changing during a delayed render prevents settling and revealing", async () => {
  const a = openActions();
  a.prepare = async () => { a.events.push("render"); await Promise.resolve(); a.invalidate(); return "A.md"; };
  expect(await openPreparedDocument(a)).toBe(false);
  expect(a.events).toEqual(["validate", "render", "validate"]);
});

test("expiry or helper loss during settle or disk refresh prevents reveal", async () => {
  const a = openActions();
  a.refresh = async (file) => { a.events.push("refresh"); a.invalidate(); return file; };
  expect(await openPreparedDocument(a)).toBe(false);
  expect(a.events).toEqual(["validate", "render", "validate", "settle", "refresh", "validate"]);
});

test("a live request validates immediately before reveal and does not validate its own focus change", async () => {
  const a = openActions();
  a.present = async () => { a.events.push("reveal"); a.invalidate(); };
  expect(await openPreparedDocument(a)).toBe(true);
  expect(a.events).toEqual(["validate", "render", "validate", "settle", "refresh", "validate", "reveal"]);
});

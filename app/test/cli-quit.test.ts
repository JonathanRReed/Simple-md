import { expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DocumentWaiters, FrameReader, frame } from "../src/main/cli-protocol";
import { startCliServer } from "../src/main/cli-server";
import { cliRuntime } from "../src/main/cli-runtime";
import { quitAfterSettle } from "../src/main/lifecycle";
import { makeDocumentId } from "../src/shared/types";

test.skipIf(process.platform === "win32")("successful quit drains normal closed frames while cancellation keeps clients waiting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-quit-wire-")), runtime = cliRuntime(root);
  const waiters = new DocumentWaiters(), id = makeDocumentId(1);
  const server = await startCliServer({ binary: "unused", profile: root, dispatch: async (_request, _stdin, closed) => waiters.add(id, closed) });
  const sockets: net.Socket[] = [];
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runtime, "state.json"), "utf8"));
    const clients = await Promise.all([1, 2].map(async number => {
      const socket = net.createConnection(path.join(runtime, "ipc.sock")); sockets.push(socket);
      const statuses: string[] = [], reader = new FrameReader();
      let accepted!: () => void;
      const ready = new Promise<void>(resolve => { accepted = resolve; });
      const ended = new Promise<void>(resolve => socket.once("end", resolve));
      socket.on("data", chunk => reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, data => {
        const response = JSON.parse(data.toString()); statuses.push(response.status); if (response.status === "accepted") accepted();
      }));
      await new Promise<void>(resolve => socket.once("connect", resolve));
      socket.write(frame(Buffer.from(JSON.stringify({ version: 1, id: `quit-${number}`, secret: state.secret, command: "open", path: path.join(root, "note.md"), wait: true }))));
      await ready;
      return { statuses, ended };
    }));
    const cleanup = async () => { waiters.closeAll(); await server.drain(); server.close(); };
    expect(await quitAfterSettle({ settle: async () => false, cleanup, exit() {} })).toBe(false);
    expect(waiters.size).toBe(2); expect(clients.map(c => c.statuses)).toEqual([["accepted"], ["accepted"]]);
    expect(await quitAfterSettle({ settle: async () => true, cleanup, exit() {} })).toBe(true);
    await Promise.all(clients.map(c => c.ended));
    expect(clients.map(c => c.statuses)).toEqual([["accepted", "closed"], ["accepted", "closed"]]);
    expect(waiters.size).toBe(0);
  } finally { sockets.forEach(socket => socket.destroy()); server.close(); fs.rmSync(runtime, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

test("quit cleanup completes waiters and drains transport before closing it", async () => {
  const source = await fs.promises.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("async function prepareQuit()"), source.indexOf("\nif (!app.requestSingleInstanceLock()"));
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
  const events: string[] = [];
  const cleanup = new Function("trace", "updates", "tray", "cliStartup", "cliServer", "cliWaiters", "registry", "configStore", "settingsWindow", "flushSettings", "dragExports", "disposeRenderer", "windows", "let quitting = false;\n" + compiled + "\nreturn prepareQuit;")(
    () => {}, undefined, undefined, Promise.resolve(), { drain: async () => events.push("drain"), close: () => events.push("transport close") },
    { closeAll: () => events.push("closed frames"), clear: () => events.push("clear") }, { dispose: () => {} }, () => ({ close() {} }), undefined, () => {}, undefined, async () => {}, new Map());
  await cleanup();
  expect(events).toEqual(["closed frames", "drain", "transport close"]);
});

test.skipIf(process.platform === "win32")("quit completion queued before acceptance drains in protocol order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-early-close-")), runtime = cliRuntime(root);
  const waiters = new DocumentWaiters();
  let dispatched!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { dispatched = resolve; });
  const dispatchGate = new Promise<void>(resolve => { release = resolve; });
  const server = await startCliServer({ binary: "unused", profile: root, dispatch: async (_request, _stdin, closed) => {
    const remove = waiters.add(makeDocumentId(1), closed); dispatched(); await dispatchGate; return remove;
  } });
  const socket = net.createConnection(path.join(runtime, "ipc.sock")), statuses: string[] = [], reader = new FrameReader();
  const ended = new Promise<void>(resolve => socket.once("end", resolve));
  socket.on("data", chunk => reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, data => statuses.push(JSON.parse(data.toString()).status)));
  try {
    await new Promise<void>(resolve => socket.once("connect", resolve));
    const state = JSON.parse(fs.readFileSync(path.join(runtime, "state.json"), "utf8"));
    socket.write(frame(Buffer.from(JSON.stringify({ version: 1, id: "early-close", secret: state.secret, command: "open", path: path.join(root, "note.md"), wait: true }))));
    await entered;
    waiters.closeAll();
    const drain = server.drain();
    release(); await drain; server.close(); await ended;
    expect(statuses).toEqual(["accepted", "closed"]);
  } finally { release(); socket.destroy(); server.close(); fs.rmSync(runtime, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed asynchronous quit cleanup preserves sessions and leaves CLI clients waiting", async () => {
  const source = await fs.promises.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("async function prepareQuit()"), source.indexOf("\nif (!app.requestSingleInstanceLock()"));
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
  const events: string[] = [];
  const cleanup = new Function("trace", "updates", "tray", "cliStartup", "cliServer", "cliWaiters", "registry", "configStore", "settingsWindow", "flushSettings", "dragExports", "disposeRenderer", "windows", "let quitting = false;\n" + compiled + "\nreturn prepareQuit;")(
    () => {}, undefined, undefined, Promise.resolve(), { drain: async () => {}, close: () => events.push("transport close") },
    { closeAll: () => events.push("closed frames"), clear: () => events.push("clear") }, { dispose: () => events.push("disposed") }, () => ({ close() {} }), undefined, () => {}, { dispose: async () => { throw new Error("cleanup failed"); } }, async () => {}, new Map());
  await expect(cleanup()).rejects.toThrow("cleanup failed");
  expect(events).toEqual([]);
});

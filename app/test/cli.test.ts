import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { DocumentWaiters, FRAME_CAP, STDIN_CAP, FrameReader, frame, parseCliRequest, parseOpenUrl } from "../src/main/cli-protocol";
import { cliRuntime, prepareCliRuntime } from "../src/main/cli-runtime";
import { startCliServer } from "../src/main/cli-server";
import { DocumentRegistry } from "../src/main/document-registry";
import { makeRevisionId } from "../src/shared/types";
const secret = "a".repeat(64);
const request = { version: 1, id: "test-1", secret, command: "open", path: path.resolve("note.md"), wait: true };

describe("CLI boundary", () => {
  test("validates authentication, version, IDs, paths, commands and stdin lengths", () => {
    expect(parseCliRequest(request, secret, 128).command).toBe("open");
    for (const change of [{ secret: "b".repeat(64) }, { secret: "é".repeat(64) }, { version: 2 }, { id: "" }, { command: "write" }, { path: "relative.md" }, { path: "/a\0b" }, { line: 0 }, { line: 4, heading: "x" }, { wait: "true" }]) expect(() => parseCliRequest({ ...request, ...change }, secret, 128)).toThrow();
    expect(() => parseCliRequest(request, secret, FRAME_CAP + 1)).toThrow();
    for (const length of [-1, 0.1, STDIN_CAP + 1]) expect(() => parseCliRequest({ ...request, command: "stdin", name: "stdin.md", length }, secret, 128)).toThrow();
    expect(parseCliRequest({ ...request, command: "stdin", name: "stdin.mdx", length: STDIN_CAP }, secret, 128).command).toBe("stdin");
    expect(() => parseCliRequest({ ...request, command: "stdin", name: "../x", length: 0 }, secret, 128)).toThrow();
  });
  test("URL scheme accepts only decoded absolute open paths and one location", () => {
    const file = path.resolve("a b#c.md");
    expect(parseOpenUrl(`simplemd://open?path=${encodeURIComponent(file)}&line=42`)).toEqual({ path: file, location: { kind: "line", line: 42 } });
    expect(parseOpenUrl(`simplemd://open?path=${encodeURIComponent(file)}&heading=same-1`).location).toEqual({ kind: "heading", heading: "same-1" });
    for (const value of ["simplemd://export?path=/tmp/a", "simplemd://open?path=relative", "simplemd://open?path=%00", "simplemd://open?path=/a&path=/b", "simplemd://open?path=/a&line=-1", "simplemd://open?path=/a&line=2&heading=x", "simplemd://open?path=/a&wait=true", "simplemd://open/extra?path=/a", "simplemd://open?path=/a#line=2"]) expect(() => parseOpenUrl(value)).toThrow();
  });
  test("frames survive fragmentation and reject oversize declarations before allocation", () => {
    const reader = new FrameReader(); const received: string[] = [];
    const bytes = Buffer.concat([frame(Buffer.from("one")), frame(Buffer.from("two"))]);
    for (const byte of bytes) reader.push(Buffer.from([byte]), bytes => received.push(bytes.toString()));
    expect(received).toEqual(["one", "two"]);
    for (const size of [0, FRAME_CAP + 1]) {
      const header = Buffer.alloc(4); header.writeUInt32BE(size);
      expect(() => new FrameReader().push(header, () => {})).toThrow();
    }
  });
  test("wait tokens survive save and Save As, support multiple callers and end at removal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-wait-"));
    const waiters = new DocumentWaiters(); const registry = new DocumentRegistry(id => waiters.closed(id));
    try {
      const doc = registry.create(null, "hello"); let completed = 0;
      waiters.add(doc.documentId, () => completed++); const cancel = waiters.add(doc.documentId, () => completed++);
      await doc.save(path.join(root, "first.md"), makeRevisionId(0));
      await doc.save(path.join(root, "second.md"), makeRevisionId(0));
      expect(completed).toBe(0); expect(waiters.size).toBe(2);
      cancel(); expect(waiters.size).toBe(1);
      registry.remove(doc.documentId); expect(completed).toBe(1); expect(waiters.size).toBe(0);
    } finally { registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform === "win32")("private Unix CLI transport", () => {
  test("rejects unsafe runtime directories without changing them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-unsafe-")); const runtime = cliRuntime(root);
    try {
      fs.mkdirSync(runtime, { mode: 0o755 });
      await expect(prepareCliRuntime("unused", root)).rejects.toThrow("Unsafe");
      expect(fs.statSync(runtime).mode & 0o777).toBe(0o755);
      fs.rmdirSync(runtime); fs.symlinkSync(root, runtime);
      await expect(prepareCliRuntime("unused", root)).rejects.toThrow("Unsafe");
    } finally { fs.rmSync(runtime, { force: true }); fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("Rust client waits for close, rejects app failure, and disconnect removes its token", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-wire-")); const runtime = cliRuntime(root);
    const binary = path.resolve(import.meta.dir, "../native/target/release/simplemd"); const callbacks = new Set<() => void>();
    let accepted!: () => void; let dispatched = new Promise<void>(resolve => { accepted = resolve; });
    const server = await startCliServer({ binary, profile: root, dispatch: async (_request, _stdin, closed) => { callbacks.add(closed); accepted(); return () => { callbacks.delete(closed); }; } });
    const children: ReturnType<typeof spawn>[] = [];
    const client = () => {
      const child = spawn(binary, ["--wait", path.join(root, "COMMIT_EDITMSG")], { env: { ...process.env, SMD_CLI_RUNTIME: runtime }, stdio: "pipe" }); children.push(child);
      return { child, exited: new Promise<number | null>(resolve => child.once("close", resolve)) };
    };
    try {
      expect(fs.statSync(runtime).mode & 0o777).toBe(0o700);
      const wrong = net.createConnection(path.join(runtime, "ipc.sock"));
      await new Promise<void>(resolve => wrong.once("connect", resolve));
      const rejected = new Promise<void>(resolve => wrong.once("close", resolve));
      wrong.write(frame(Buffer.from(JSON.stringify({ ...request, secret: "b".repeat(64) })))); await rejected;
      expect(callbacks.size).toBe(0);
      const one = client(); await dispatched;
      await new Promise(resolve => setTimeout(resolve, 30)); expect(one.child.exitCode).toBeNull();
      for (const closed of callbacks) closed(); expect(await one.exited).toBe(0);
      dispatched = new Promise<void>(resolve => { accepted = resolve; });
      const two = client(); await dispatched; two.child.kill("SIGINT"); expect(await two.exited).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 30)); expect(callbacks.size).toBe(0);
      dispatched = new Promise<void>(resolve => { accepted = resolve; });
      const three = client(); await dispatched; server.close(); expect(await three.exited).toBe(1);
    } finally { for (const child of children) child.kill("SIGKILL"); server.close(); fs.rmSync(runtime, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
  }, 10000);
});

import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { startCliServer } from "../src/main/cli-server";

test("a broken broker pipe rejects quit draining without an unhandled stream error", async () => {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const failure = Object.assign(new Error("broker stopped"), { code: "EPIPE" });
  const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(failure); } });
  const broker = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() { broker.emit("exit", 1); stdout.end(); stderr.end(); } });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const server = await startCliServer({ binary: "unused", dispatch: async () => undefined }, {
      platform: "win32",
      runtime: async () => ({ directory: "/private/test", endpoint: "unused", secret: "unused", cleanup() {} }),
      broker: () => { queueMicrotask(() => stdout.write('{"ready":true}\n')); return broker; },
    });
    await expect(server.drain()).rejects.toThrow("broker stopped");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(log).toHaveBeenCalled();
    server.close();
  } finally { log.mockRestore(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});

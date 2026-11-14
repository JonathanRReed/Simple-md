import { expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createInterface } from "node:readline";

test("a broken broker pipe rejects quit draining without an unhandled stream error", async () => {
  const source = await fs.readFile(new URL("../src/main/cli-server.ts", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("export async function startCliServer("), source.indexOf("export async function startOptionalCliServer(")).replace("export ", "");
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
  const stdout = new PassThrough(), stderr = new PassThrough();
  const failure = Object.assign(new Error("broker stopped"), { code: "EPIPE" });
  const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(failure); } });
  const broker = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() { broker.emit("exit", 1); stdout.end(); stderr.end(); } });
  const start = new Function("prepareCliRuntime", "perfMark", "spawn", "createInterface", "process", compiled + "\nreturn startCliServer;")(
    async () => ({ directory: "/private/test", secret: "unused", cleanup() {} }), () => {},
    () => { queueMicrotask(() => stdout.write('{"ready":true}\n')); return broker; }, createInterface, { platform: "win32", env: {} });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const server = await start({ binary: "unused", dispatch: async () => {} });
    await expect(server.drain()).rejects.toThrow("broker stopped");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(log).toHaveBeenCalled();
    server.close();
  } finally { log.mockRestore(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});

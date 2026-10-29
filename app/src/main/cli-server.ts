import { perfMark } from "./perf.js";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CLI_VERSION, STDIN_CAP, FrameReader, frame, parseCliRequest, type CliRequest } from "./cli-protocol.js";
import { prepareCliRuntime } from "./cli-runtime.js";

export type CliDispatch = (request: CliRequest, stdin: string, closed: () => void, signal: AbortSignal) => Promise<(() => void) | undefined>;
export async function startCliServer(options: { binary: string; profile?: string; dispatch: CliDispatch }): Promise<{ close(): void }> {
  perfMark("cli-runtime-start");
  const runtime = await prepareCliRuntime(options.binary, options.profile);
  perfMark("cli-runtime-ready");
  let stopTransport = () => {};
  try {
    const active = new Set<() => void>();
    const handle = (send: (value: object) => void, end: () => void) => {
      const controller = new AbortController(); let remove: (() => void) | undefined; let id = "invalid"; let closed = false;
      const cleanup = () => { controller.abort(); remove?.(); active.delete(cleanup); };
      active.add(cleanup);
      let accepted = false;
      const complete = () => {
        if (controller.signal.aborted) return;
        send({ version: CLI_VERSION, id, status: "closed" }); cleanup(); end();
      };
      return { cleanup, async request(request: CliRequest, stdin: string) {
        id = request.id;
        try {
          remove = await options.dispatch(request, stdin, () => { closed = true; if (accepted) complete(); }, controller.signal);
          if (controller.signal.aborted) { remove?.(); return; }
          send({ version: CLI_VERSION, id, status: "accepted" }); accepted = true;
          if (request.command === "export" || !request.wait) { cleanup(); end(); return; }
          if (closed) complete();
        } catch (error) {
          send({ version: CLI_VERSION, id, status: "error", message: error instanceof Error ? error.message : String(error) }); cleanup(); end();
        }
      } };
    };
    if (process.platform === "win32") {
      const broker = spawn(options.binary, ["--ipc-broker"], { env: options.profile ? { ...process.env, SMD_CLI_RUNTIME: runtime.directory } : process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      stopTransport = () => { broker.kill(); };
      const clients = new Map<number, ReturnType<typeof handle>>();
      const lines = createInterface({ input: broker.stdout });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Private pipe did not start.")), 5000);
        broker.once("error", reject); broker.once("exit", () => { clearTimeout(timer); reject(new Error("Private pipe stopped.")); for (const client of clients.values()) client.cleanup(); runtime.cleanup(); });
        lines.on("line", line => {
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== "object") throw new Error("Invalid broker message.");
            if ("ready" in value && value.ready === true) { clearTimeout(timer); resolve(); return; }
            if (!("connection" in value) || typeof value.connection !== "number") throw new Error("Missing pipe connection.");
            const connection = value.connection;
            if ("disconnected" in value) { clients.get(connection)?.cleanup(); clients.delete(connection); return; }
            if (!("request" in value) || !("stdin" in value) || typeof value.stdin !== "string") throw new Error("Invalid pipe request.");
            let request: CliRequest;
            try {
              request = parseCliRequest(value.request, runtime.secret, Buffer.byteLength(JSON.stringify(value.request)));
              if (request.command === "stdin" && Buffer.byteLength(value.stdin) !== request.length) throw new Error("Invalid stdin payload.");
            } catch (error) {
              const raw = value.request;
              const id = raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string" && raw.id.length <= 128 ? raw.id : "invalid";
              broker.stdin.write(JSON.stringify({ connection, response: { version: CLI_VERSION, id, status: "error", message: error instanceof Error ? error.message : "Invalid request." } }) + "\n");
              return;
            }
            const client = handle(response => broker.stdin.write(JSON.stringify({ connection, response }) + "\n"), () => { clients.delete(connection); });
            clients.set(connection, client);
            void client.request(request, value.stdin);
          } catch { broker.kill(); }
        });
      });
      broker.stderr.on("data", () => {});
      return { close() { for (const cleanup of active) cleanup(); broker.kill(); runtime.cleanup(); } };
    }
    const sockets = new Set<net.Socket>();
    const unauthenticated = new Set<net.Socket>();
    const authenticated = new Set<net.Socket>();
    const server = net.createServer(socket => {
      if (unauthenticated.size >= 16) { socket.destroy(); return; }
      sockets.add(socket); unauthenticated.add(socket);
      const reader = new FrameReader();
      let pending: CliRequest | undefined; let started = false;
      const client = handle(value => socket.write(frame(Buffer.from(JSON.stringify(value)))), () => socket.end());
      const dispatch = (request: CliRequest, text: string) => {
        started = true; reader.cap = 0; clearTimeout(authenticationTimer);
        void client.request(request, text);
      };
      const authenticationTimer = setTimeout(() => socket.destroy(), 20_000);
      socket.on("data", chunk => {
        try { reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, bytes => {
          if (started) throw new Error("Only one request per connection is allowed.");
          if (pending) {
            if (pending.command !== "stdin" || bytes.length !== pending.length) throw new Error("Invalid stdin frame.");
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            dispatch(pending, text); return;
          }
          const request = parseCliRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), runtime.secret, bytes.length);
          if (authenticated.size >= 256) {
            started = true; reader.cap = 0;
            socket.end(frame(Buffer.from(JSON.stringify({ version: CLI_VERSION, id: request.id, status: "error", message: "Too many authenticated CLI connections. Close a waiting session and retry." }))));
            return;
          }
          unauthenticated.delete(socket); authenticated.add(socket);
          if (request.command === "stdin" && request.length) { pending = request; reader.cap = Math.min(STDIN_CAP, request.length); }
          else dispatch(request, "");
        }); } catch { socket.destroy(); }
      });
      socket.on("error", () => {});
      socket.on("close", () => { clearTimeout(authenticationTimer); sockets.delete(socket); unauthenticated.delete(socket); authenticated.delete(socket); client.cleanup(); });
    });
    stopTransport = () => { server.close(() => runtime.cleanup()); };
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(runtime.endpoint, () => resolve()); });
    fs.chmodSync(runtime.endpoint, 0o600);
    perfMark("cli-listening");
    let closed = false;
    return { close() { if (closed) return; closed = true; for (const cleanup of active) cleanup(); for (const socket of sockets) socket.destroy(); stopTransport(); runtime.cleanup(); } };
  } catch (error) { stopTransport(); runtime.cleanup(); throw error; }
}

export async function startOptionalCliServer(options: Parameters<typeof startCliServer>[0]): Promise<Awaited<ReturnType<typeof startCliServer>> | undefined> {
  try { return await startCliServer(options); }
  catch (error) { console.error("simplemd: CLI unavailable", error); return undefined; }
}

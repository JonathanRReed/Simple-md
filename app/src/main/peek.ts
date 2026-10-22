import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { PeekSession, type PeekRequest } from "./peek-request.js";
export type { PeekRequest } from "./peek-request.js";

export type PeekPermission = "granted" | "missing" | "unsupported" | "unknown";

export interface PeekHandlers {
  /**
   * The user pressed bare Space in a file manager and the helper swallowed it. `paths` are the Markdown
   * files it already found selected; empty means the app must look the selection up and may hand the key back.
   */
  onPeek(request: PeekRequest): void;
  /** The file manager's selection changed; used to pre-render before Space is pressed. */
  onSelection(paths: string[]): void;
  onAutomationDenied(): void;
  onPermission(state: PeekPermission): void;
}

interface HelperEvent {
  event?: string;
  state?: PeekPermission;
  permission?: PeekPermission;
  paths?: string[];
  requestId?: number;
  origin?: string;
  message?: string;
  valid?: boolean;
}

function helperPath(): string | null {
  const exe = process.platform === "win32" ? "simple-md-peek.exe" : "simple-md-peek";
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "native", exe)]
    : [path.join(app.getAppPath(), "native", "target", "release", exe)];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export class PeekHelper {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private requests: PeekSession | undefined;
  private stopped = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private enabled = true;
  permission: PeekPermission = "unknown";

  constructor(private readonly handlers: PeekHandlers) {}

  start(): void {
    const bin = helperPath();
    if (!bin || this.child) return;
    this.stopped = false;
    const args = process.platform === "win32" && !app.isPackaged && process.env.SMD_EXPERIMENTAL_WINDOWS_SPACE === "1" ? ["--experimental-space"] : [];
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    const requests = new PeekSession((command) => {
      if (this.child !== child || !child.stdin.writable || child.killed) return false;
      try {
        child.stdin.write(JSON.stringify(command) + "\n");
        return true;
      } catch {
        return false;
      }
    });
    this.requests = requests;
    this.setEnabled(this.enabled);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (child === this.child) this.read(chunk, requests); });
    if (process.env.SMD_TRACE) {
      child.stderr.on("data", (d: Buffer) => console.error(`[helper-err] ${String(d).trim()}`));
    } else {
      child.stderr.resume();
    }
    child.stdin.on("error", () => {});
    const exited = () => {
      requests.close();
      if (this.child !== child) return;
      this.child = undefined;
      this.buffer = "";
      if (this.stopped || this.restarts >= 3) return;
      this.restarts++;
      this.restartTimer = setTimeout(() => { if (!this.stopped) this.start(); }, 500 * this.restarts);
      this.restartTimer.unref();
    };
    child.on("error", exited);
    child.on("exit", exited);
  }

  private read(chunk: string, requests: PeekSession): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      if (process.env.SMD_TRACE) console.error(`[helper] ${line}`);
      try {
        this.handle(JSON.parse(line) as HelperEvent, requests);
      } catch {
        // A malformed line must never take the app down.
      }
    }
  }

  private handle(msg: HelperEvent, requests: PeekSession): void {
    if (msg.event === "ready" || msg.event === "permission") {
      this.restarts = 0;
      this.permission = msg.state ?? msg.permission ?? "unknown";
      this.handlers.onPermission(this.permission);
    } else if (msg.event === "peek") {
      if (typeof msg.requestId !== "number" || !Number.isSafeInteger(msg.requestId)) return;
      const request = requests.request(msg.requestId, Array.isArray(msg.paths) ? msg.paths.filter((p) => typeof p === "string") : [], typeof msg.origin === "string" ? msg.origin : undefined);
      if (request) this.handlers.onPeek(request);
    } else if (msg.event === "peek-valid") {
      if (typeof msg.requestId === "number" && typeof msg.valid === "boolean") requests.validation(msg.requestId, msg.valid);
    } else if (msg.event === "selection") {
      this.handlers.onSelection(Array.isArray(msg.paths) ? msg.paths.filter((p) => typeof p === "string") : []);
    } else if (msg.event === "error" && msg.message === "finder-automation-denied") {
      this.handlers.onAutomationDenied();
    }
  }

  private send(cmd: object): void {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(cmd) + "\n");
  }

  get running(): boolean {
    return this.child !== undefined;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.send({ cmd: "set-enabled", enabled });
  }

  stop(): void {
    this.stopped = true;
    this.requests?.close();
    clearTimeout(this.restartTimer);
    this.send({ cmd: "quit" });
    const child = this.child;
    this.child = undefined;
    setTimeout(() => child?.kill(), 500).unref();
  }
}

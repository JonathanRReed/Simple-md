import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

export function cliRuntime(profile?: string): string {
  const uid = process.getuid?.() ?? 0;
  return profile ? `/tmp/smd-${uid}-${createHash("sha256").update(profile).digest("hex").slice(0, 10)}` : `/tmp/smd-${uid}`;
}
function live(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}
async function refused(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(endpoint);
    const done = (stale: boolean) => { socket.destroy(); resolve(stale); };
    socket.once("connect", () => done(false));
    socket.once("error", error => done("code" in error && error.code === "ECONNREFUSED"));
    socket.setTimeout(400, () => done(false));
  });
}
export async function prepareCliRuntime(binary: string, profile?: string): Promise<{ directory: string; endpoint: string; secret: string; cleanup(): void }> {
  let directory: string;
  let endpoint: string;
  if (process.platform === "win32") {
    const info: unknown = JSON.parse(execFileSync(binary, ["--runtime-info"], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096 }));
    if (!info || typeof info !== "object" || !("directory" in info) || typeof info.directory !== "string" || !("endpoint" in info) || typeof info.endpoint !== "string") throw new Error("Invalid private pipe runtime.");
    directory = info.directory; endpoint = info.endpoint;
  } else {
    directory = profile ? cliRuntime(profile) : cliRuntime(); endpoint = path.join(directory, "ipc.sock");
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error("Unsafe CLI runtime directory.");
  }
  const stateFile = path.join(directory, "state.json");
  const old = fs.lstatSync(stateFile, { throwIfNoEntry: false });
  let oldPid: number | undefined;
  if (old) {
    if (!old.isFile() || old.size > 4096 || (process.platform !== "win32" && (old.uid !== process.getuid?.() || (old.mode & 0o777) !== 0o600))) throw new Error("Unsafe CLI state.");
    const state: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!state || typeof state !== "object" || !("pid" in state) || typeof state.pid !== "number" || !Number.isSafeInteger(state.pid) || state.pid <= 0) throw new Error("Invalid CLI owner PID.");
    oldPid = state.pid;
    if (live(oldPid)) throw new Error("The CLI endpoint owner is still alive.");
  }
  if (process.platform !== "win32") {
    const socket = fs.lstatSync(endpoint, { throwIfNoEntry: false });
    if (socket) {
      if (!socket.isSocket() || socket.uid !== process.getuid?.() || oldPid === undefined || !(await refused(endpoint))) throw new Error("Cannot prove the CLI endpoint is stale.");
      fs.unlinkSync(endpoint);
    }
  }
  const secret = randomBytes(32).toString("hex");
  const temporary = path.join(directory, `state-${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, pid: process.pid, secret }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { directory, endpoint, secret, cleanup() {
    // A different server's state must never be removed during shutdown.
    try {
      const state: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (state && typeof state === "object" && "secret" in state && state.secret === secret) fs.unlinkSync(stateFile);
    } catch {}
  } };
}

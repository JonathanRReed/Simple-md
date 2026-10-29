import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

let helper: ChildProcessWithoutNullStreams | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();

export function stopMetadataHelper(): void {
  const child = helper;
  helper = undefined;
  child?.kill();
  for (const request of pending.values()) request.reject(new Error("Metadata copy helper stopped."));
  pending.clear();
}

function startHelper(): ChildProcessWithoutNullStreams {
  if (helper) return helper;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.resourcesPath ?? "", "native", "simplemd-peek"),
    path.resolve(here, "../native/target/release/simplemd-peek"),
    path.resolve(here, "../../native/target/release/simplemd-peek"),
  ];
  const binary = candidates.find((candidate) => fs.existsSync(candidate));
  if (!binary) throw new Error("Build the native helper before saving: bun run build:native.");
  const child = spawn(binary, ["--copy-metadata"], { stdio: ["pipe", "pipe", "pipe"] });
  helper = child;
  child.stderr.resume();
  const failed = () => { if (helper === child) stopMetadataHelper(); };
  child.on("error", failed);
  child.on("exit", failed);
  child.stdin.on("error", failed);
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (helper !== child) return;
    try {
      const reply: unknown = JSON.parse(line);
      if (!reply || typeof reply !== "object" || !("id" in reply) || typeof reply.id !== "number" ||
          !("error" in reply) || (reply.error !== null && typeof reply.error !== "string")) throw new Error("Invalid metadata reply.");
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      if (reply.error) request.reject(new Error(reply.error));
      else request.resolve();
    } catch { failed(); }
  });
  return child;
}

export async function copyMetadata(source: string, target: string): Promise<void> {
  const child = startHelper();
  const id = ++sequence;
  const timer = setTimeout(() => { if (helper === child) stopMetadataHelper(); }, 5000);
  try {
    await new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, source, target }) + "\n");
    });
  } finally { clearTimeout(timer); }
}

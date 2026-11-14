import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export function nativeFileHelper(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const executable = process.platform === "win32" ? "simplemd-helper.exe" : "simplemd-helper";
  const candidates = [
    path.join(process.resourcesPath ?? "", "native", executable),
    path.resolve(here, "../native/target/release", executable),
    path.resolve(here, "../../native/target/release", executable),
  ];
  const binary = candidates.find((candidate) => fs.existsSync(candidate));
  if (!binary) throw new Error("Build the native helper before saving: bun run build:native.");
  return binary;
}
export async function copyMetadata(source: string, target: string): Promise<void> {
  await run(nativeFileHelper(), ["--copy-metadata", source, target], { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
}

export async function exchangeFiles(source: string, target: string, metadata = false): Promise<{ exchanged: boolean; metadataCopyFailed: boolean }> {
  try {
    const { stdout } = await run(nativeFileHelper(), [metadata ? "--exchange-with-metadata" : "--exchange", source, target], { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    return { exchanged: true, metadataCopyFailed: stdout.includes("METADATA_FAILED") };
  } catch (error) {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.split("\n").some(line => line.startsWith("NOSWAP:"))) {
      return { exchanged: false, metadataCopyFailed: "stdout" in error && typeof error.stdout === "string" && error.stdout.includes("METADATA_FAILED") };
    }
    throw error;
  }
}

async function exclusiveRename(source: string, target: string): Promise<void> {
  try { await run(nativeFileHelper(), ["--move-no-replace", source, target], { timeout: 5000, maxBuffer: 64 * 1024 }); }
  catch (error) {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
      if (error.stderr.startsWith("NOEXCL:")) throw Object.assign(new Error(error.stderr, { cause: error }), { code: "NOEXCL" });
      if (error.stderr.startsWith("EXDEV:")) throw Object.assign(new Error(error.stderr, { cause: error }), { code: "EXDEV" });
      if (error.stderr.startsWith("EEXIST:")) throw Object.assign(new Error("The destination already exists.", { cause: error }), { code: "EEXIST" });
    }
    throw error;
  }
}

export async function renameNoReplace(source: string, target: string, io = { exclusive: exclusiveRename, rename: fs.promises.rename }): Promise<void> {
  try { await io.exclusive(source, target); return; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "NOEXCL")) throw error;
  }
  const reserved = await fs.promises.open(target, "wx", 0o600);
  const identity = await reserved.stat();
  try {
    await reserved.close();
    await io.rename(source, target);
  } catch (error) {
    await reserved.close().catch(() => {});
    const current = await fs.promises.lstat(target).catch(() => null);
    if (current?.dev === identity.dev && current.ino === identity.ino) await fs.promises.unlink(target);
    throw error;
  }
}

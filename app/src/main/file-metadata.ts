import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function copyMetadata(source: string, target: string): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.resourcesPath ?? "", "native", "simplemd-helper"),
    path.resolve(here, "../native/target/release/simplemd-helper"),
    path.resolve(here, "../../native/target/release/simplemd-helper"),
  ];
  const binary = candidates.find((candidate) => fs.existsSync(candidate));
  if (!binary) throw new Error("Build the native helper before saving: bun run build:native.");
  await run(binary, ["--copy-metadata", source, target], { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
}

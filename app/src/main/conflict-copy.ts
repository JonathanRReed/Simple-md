import fs from "node:fs/promises";
import path from "node:path";
import { readDiskText, writeAtomic } from "./files.js";

/** A conflict copy never changes the session or replaces its incoming file. */
export async function writeConflictCopy(original: string | null, target: string, text: string): Promise<void> {
  const canonical = async (file: string) => fs.realpath(file).catch(() => path.resolve(file));
  if (original && await canonical(original) === await canonical(target)) throw new Error("Choose a different file to keep both versions.");
  await writeAtomic(target, text, await readDiskText(target));
}

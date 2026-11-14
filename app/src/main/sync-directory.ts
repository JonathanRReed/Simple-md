import fs from "node:fs";
import path from "node:path";

/** Best effort after publication: a successful replacement must stay a successful save. */
export async function syncDirectory(file: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const directory = await fs.promises.open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { console.error("simplemd: could not sync saved file directory", error); }
}

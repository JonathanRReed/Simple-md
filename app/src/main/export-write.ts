import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const existsMessage = (target: string) => `Export destination already exists: ${target}. Use --force to replace it.`;

export async function checkExportDestination(target: string, overwrite: boolean): Promise<fs.Stats | null> {
  const stat = await fs.promises.lstat(target).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (stat && !overwrite) throw new Error(existsMessage(target));
  if (stat && !stat.isFile()) throw new Error("Export can replace only a regular file.");
  return stat;
}

export async function writeExportAtomic(target: string, data: Buffer | string, overwrite: boolean): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    const stat = await checkExportDestination(target, overwrite);
    const handle = await fs.promises.open(temporary, "wx", 0o666);
    try { await handle.writeFile(data); if (stat) await handle.chmod(stat.mode & 0o7777); await handle.sync(); } finally { await handle.close(); }
    if (overwrite) {
      await fs.promises.rename(temporary, target);
    } else {
      // link is an atomic no-clobber publish, including when another writer wins.
      try { await fs.promises.link(temporary, target); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && ["EPERM", "ENOTSUP", "EXDEV"].includes(String(error.code)))) throw error;
        const output = await fs.promises.open(target, "wx", 0o666);
        try { await output.writeFile(data); await output.sync(); } finally { await output.close(); }
      }
    }
  } catch (error) {
    if (!overwrite && error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error(existsMessage(target), { cause: error });
    throw error;
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

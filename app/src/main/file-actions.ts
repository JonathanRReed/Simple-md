import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readRegularFile, writeAtomic, FileConflictError } from "./files.js";
import { copyMetadata, renameNoReplace } from "./file-metadata.js";
import { syncDirectory } from "./sync-directory.js";
import { git } from "./git-runner.js";

export function saveSuggestion(name: string, folder: string): string {
  return path.join(folder, path.extname(name) ? name : `${name}.md`);
}
export function duplicateSuggestion(file: string): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)} copy${ext}`);
}
export async function relativeGitPath(file: string): Promise<string | null> {
  try {
    const folder = await fs.promises.realpath(path.dirname(file));
    const root = (await git(["rev-parse", "--show-toplevel"], folder)).trimEnd();
    const relative = path.relative(root, path.join(folder, path.basename(file)));
    return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : null;
  } catch { return null; }
}
export function hasRelativeResources(text: string): boolean {
  // Inline links/images, definitions and HTML resources. A warning may be conservative.
  return /(?:\]\(\s*<?|^\s*\[[^\]]+\]:\s*<?|\b(?:src|href)\s*=\s*["'])(?![a-z][a-z\d+.-]*:|\/|#|>|["']|\s)([^\s)>"']+)/im.test(text);
}
export type Destination = { kind: "absent" } | { kind: "existing"; bytes: Buffer; dev: number; ino: number; mtimeMs: number; ctimeMs: number };
export async function destinationState(file: string): Promise<Destination> {
  const stat = await fs.promises.lstat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return { kind: "absent" };
  if (!stat.isFile()) throw new Error("Choose a regular file destination.");
  return { kind: "existing", bytes: await readRegularFile(file), dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
async function checkDestination(file: string, expected: Destination): Promise<void> {
  const latest = await destinationState(file);
  if (latest.kind !== expected.kind || latest.kind === "existing" && expected.kind === "existing" &&
      (latest.dev !== expected.dev || latest.ino !== expected.ino || latest.mtimeMs !== expected.mtimeMs || latest.ctimeMs !== expected.ctimeMs || !latest.bytes.equals(expected.bytes))) throw new FileConflictError();
}
const operations = {
  rename: renameNoReplace,
  copy: async (source: string, target: string) => {
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    if (process.platform === "darwin") await copyMetadata(source, target);
    await fs.promises.chmod(target, (await fs.promises.stat(source)).mode & 0o7777);
    const handle = await fs.promises.open(target, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  },
  remove: fs.promises.unlink,
};
/** Keep a rollback copy of a confirmed replacement until the source is removed. */
export async function moveDocumentFile(source: string, target: string, text: string, expected: Destination, io = operations): Promise<void> {
  if (source === target) return;
  const bytes = await readRegularFile(source);
  if (!bytes.equals(Buffer.from(text, "utf8"))) throw new FileConflictError();
  if ((await fs.promises.lstat(source)).isSymbolicLink()) throw new Error("Move the original file instead of its symbolic link.");
  if (expected.kind === "existing") {
    const stat = await fs.promises.stat(source);
    if (stat.dev === expected.dev && stat.ino === expected.ino) {
      const name = path.basename(source), renamed = path.basename(target);
      const sameFolder = await fs.promises.realpath(path.dirname(source)) === await fs.promises.realpath(path.dirname(target));
      const entries = sameFolder ? await fs.promises.readdir(path.dirname(source)) : [];
      if (!sameFolder || name === renamed || name.toLowerCase() !== renamed.toLowerCase() || entries.includes(renamed)) throw new Error("Choose a different file.");
      // A case-insensitive filesystem names the same entry through both paths.
      const temporary = path.join(path.dirname(source), `.${name}.${randomUUID()}.rename`);
      await io.rename(source, temporary);
      try { await io.rename(temporary, target); }
      catch (error) {
        try { await renameNoReplace(temporary, source); }
        catch (restoreError) { throw new Error(`Restore the original file from ${temporary}.`, { cause: restoreError }); }
        throw error;
      }
      await syncDirectory(target);
      return;
    }
  }
  await checkDestination(target, expected);
  const backup = expected.kind === "existing" ? path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.backup`) : null;
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.move`);
  let published = false, originalMoved = false, backedUp = false;
  try {
    if (backup) { await io.rename(target, backup); backedUp = true; }
    try {
      await io.rename(source, target);
      originalMoved = published = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
      await io.copy(source, temporary);
      if (!(await readRegularFile(temporary)).equals(bytes) || !(await readRegularFile(source)).equals(bytes)) throw new FileConflictError();
      await checkDestination(target, { kind: "absent" });
      await io.rename(temporary, target); published = true;
      if (!(await readRegularFile(target)).equals(bytes) || !(await readRegularFile(source)).equals(bytes)) throw new FileConflictError();
      await io.remove(source); originalMoved = true;
    }
  } catch (error) {
    if (published && !originalMoved) {
      const latest = await readRegularFile(target).catch(() => null);
      if (!latest?.equals(bytes)) throw new Error(`The destination changed during the move. The original is still at ${source}.${backup ? ` The previous destination is at ${backup}.` : ""}`, { cause: error });
      await fs.promises.unlink(target);
    }
    if (backedUp && backup) {
      try { await renameNoReplace(backup, target); }
      catch (restoreError) { throw new Error(`The original is still at ${source}. Restore the previous destination from ${backup}.`, { cause: restoreError }); }
    }
    throw error;
  } finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
  // Publication and removal succeeded. Cleanup cannot turn this into a failed move.
  if (backup) await fs.promises.rm(backup, { force: true }).catch(error => console.error("simplemd: could not remove move backup", error));
  await syncDirectory(source); await syncDirectory(target);
}

export async function duplicateDocumentFile(target: string, text: string, expected: Destination): Promise<void> {
  await checkDestination(target, expected);
  await writeAtomic(target, text, expected.kind === "existing" ? expected.bytes.toString("utf8") : null);
}

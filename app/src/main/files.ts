import fs from "node:fs";
import { syncDirectory } from "./sync-directory.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyMetadata, exchangeFiles, renameNoReplace } from "./file-metadata.js";

export const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx", ".txt"]);
export const isMarkdown = (p: string) => MARKDOWN_EXT.has(path.extname(p).toLowerCase());

export class FileConflictError extends Error {
  constructor(readonly recoveryPath?: string) {
    super("The note changed on disk. Reload it or choose Keep mine before saving." + (recoveryPath ? ` Another version was kept at ${recoveryPath}.` : ""));
  }
}

export const ENCODING_NOTICE = "Not a UTF-8 text file. Read only.";

export class FileEncodingError extends Error {
  constructor() { super(ENCODING_NOTICE); }
}

export function decodeDocument(bytes: Uint8Array): { text: string; readOnlyReason?: string } {
  try {
    // NULs also catch BOM-less UTF-16 that otherwise looks like valid UTF-8.
    if (bytes.includes(0)) throw new FileEncodingError();
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), readOnlyReason: ENCODING_NOTICE };
  }
}

// The 20 MB rendering gate fits below this hard read limit.
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const READ_ONLY_NOTICE = "This file is locked or not writable. Read only.";

export class FileChangedDuringReadError extends Error {
  constructor() { super("This file keeps changing. Try again."); }
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export async function readRegularFile(file: string, maxBytes = MAX_DOCUMENT_BYTES, noFollow = false): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (noFollow ? fs.constants.O_NOFOLLOW : 0));
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) throw Object.assign(new Error("Cannot open a directory. Choose a text file."), { code: "EISDIR" });
      if (!stat.isFile()) throw new Error("Only regular files can be opened.");
      if (stat.size > maxBytes) throw new Error(`File exceeds the ${maxBytes / 1024 / 1024} MB read limit.`);
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maxBytes) throw new Error(`File exceeds the ${maxBytes / 1024 / 1024} MB read limit.`);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      const named = await fs.promises.stat(file).catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
        throw err;
      });
      if (named && total === stat.size && sameFile(stat, after) && sameFile(after, named)) return Buffer.concat(chunks, total);
    } finally { await handle.close(); }
  }
  throw new FileChangedDuringReadError();
}

export async function readDocument(file: string) {
  const doc = decodeDocument(await readRegularFile(file));
  if (doc.readOnlyReason) return doc;
  // macOS access(W_OK) rejects UF_IMMUTABLE and SF_IMMUTABLE, as well as permissions.
  const writable = await fs.promises.access(file, fs.constants.W_OK).then(() => true, () => false);
  return writable ? doc : { ...doc, readOnlyReason: READ_ONLY_NOTICE };
}

export async function readDiskText(file: string): Promise<string | null> {
  try {
    const doc = await readDocument(file);
    if (doc.readOnlyReason) throw new Error(doc.readOnlyReason);
    return doc.text;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeAtomic(file: string, text: string, expectedText?: string | null): Promise<{ metadataCopyFailed: boolean }> {
  let metadataCopyFailed = false;
  const entry = await fs.promises.lstat(file).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  });
  const target = entry?.isSymbolicLink() ? await fs.promises.realpath(file) : file;
  const stat = entry?.isSymbolicLink() ? await fs.promises.stat(target) : entry;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const written = Buffer.from(text, "utf8");
  let displaced = false;
  try {
    // Reject encoded/binary files even if the caller did not supply a disk revision.
    const baseline = stat ? await readDiskText(target) : null;
    const expected = expectedText === undefined ? baseline : expectedText;
    if (expectedText !== undefined && baseline !== expectedText) throw new FileConflictError();
    const canExchange = !!stat && expected !== null && process.platform !== "win32";
    const handle = await fs.promises.open(tmp, "wx", stat ? stat.mode & 0o7777 : 0o666);
    try {
      await handle.truncate(0);
      await handle.writeFile(text, "utf8");
      if (stat) await handle.chmod(stat.mode & 0o7777);
      // The combined macOS helper fsyncs data and copied metadata together,
      // before exchange. Avoid two durable flushes for the same save.
      if (!(canExchange && process.platform === "darwin")) await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      if (entry?.isSymbolicLink() && (await fs.promises.realpath(file)) !== target) throw new FileConflictError();
      if (!entry?.isSymbolicLink()) {
        const latest = await fs.promises.lstat(file).catch((err: unknown) => {
          if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
          throw err;
        });
        if (latest?.isSymbolicLink()) throw new FileConflictError();
      }
      // Exchange checks the displaced revision itself; only rename needs a
      // second read here. Unsupported exchanges also recheck before falling back.
      if (!canExchange && expectedText !== undefined && (await readDiskText(target)) !== expectedText) throw new FileConflictError();
      try {
        if (canExchange) {
          // Even a killed helper may have completed the exchange. Until verified,
          // the temp file may contain the only copy of another program's bytes.
          displaced = true;
          const result = await exchangeFiles(tmp, target, process.platform === "darwin").catch(async (failure: unknown) => {
            // The helper could not run, timed out or was refused. What the temporary file
            // now holds says whether the exchange happened, so a helper failure costs
            // file tags at most, never the save.
            const held = await readRegularFile(tmp, MAX_DOCUMENT_BYTES, true).catch(() => null);
            if (held?.equals(written)) {
              const lostMetadata = process.platform === "darwin" && await copyMetadata(target, tmp).then(() => false, () => true);
              const pending = await fs.promises.open(tmp, "r+");
              try { await pending.sync(); } finally { await pending.close(); }
              return { exchanged: false, metadataCopyFailed: lostMetadata };
            }
            if (held?.equals(Buffer.from(expected, "utf8"))) return { exchanged: true, metadataCopyFailed: false };
            throw failure;
          });
          metadataCopyFailed = result.metadataCopyFailed;
          if (metadataCopyFailed) console.error("simplemd: could not preserve file metadata");
          if (result.exchanged) {
            const old = await fs.promises.lstat(tmp).catch(() => null);
            const bytes = old?.isFile() ? await readRegularFile(tmp, MAX_DOCUMENT_BYTES, true).catch(() => null) : null;
            if (bytes?.equals(Buffer.from(expected, "utf8"))) {
              try {
                await fs.promises.unlink(tmp);
                displaced = false;
                break;
              } catch {
                // Publication cannot finish cleanly. Restore before reporting it.
              }
            }
            if (!(await exchangeFiles(tmp, target)).exchanged) throw new Error("Could not restore the displaced file.");
            const returned = await readRegularFile(tmp, MAX_DOCUMENT_BYTES, true).catch(() => null);
            if (!returned) throw new FileConflictError(await keepForRecovery(tmp, target));
            if (returned.equals(written)) {
              await fs.promises.unlink(tmp);
              displaced = false;
              await syncDirectory(target);
              throw new FileConflictError();
            }
            // A second writer replaced our published file before rollback.
            // Put that newer version back and retain everything else as a sibling.
            if (!(await exchangeFiles(tmp, target)).exchanged) throw new Error("Could not restore the newer file.");
            const recovery = path.join(path.dirname(target), `${path.basename(target)}.simplemd-conflict-${randomUUID()}`);
            await renameNoReplace(tmp, recovery);
            displaced = false;
            await syncDirectory(target);
            throw new FileConflictError(recovery);
          }
          displaced = false;
          // Unsupported volumes retain the comparison immediately before rename.
          if ((await readDiskText(target)) !== expected) throw new FileConflictError();
        }
        if (expectedText === null) {
          // Exclusive publication prevents a new draft from replacing a file that
          // appeared between the revision check and publication.
          await renameNoReplace(tmp, target);
        } else await fs.promises.rename(tmp, target);
        break;
      }
      catch (err) {
        // Windows can hold the destination briefly during concurrent renames.
        // Recheck the disk revision and symlinks after each bounded delay.
        if (process.platform !== "win32" || attempt >= 5 || !(err instanceof Error && "code" in err && ["EPERM", "EACCES", "EBUSY"].includes(String(err.code)))) throw err;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
    await syncDirectory(target);
    return { metadataCopyFailed };
  } catch (err) {
    if (displaced) {
      // Do not assume that an unsuccessful helper invocation did not publish.
      // Keep unknown bytes, including unreadable files, for manual recovery.
      const bytes = await readRegularFile(tmp, MAX_DOCUMENT_BYTES, true).catch(() => null);
      if (!bytes?.equals(written)) throw new FileConflictError(await keepForRecovery(tmp, target));
    }
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Gives bytes that cannot be accounted for a visible name beside the document, so they are not lost in a hidden file. */
async function keepForRecovery(tmp: string, target: string): Promise<string> {
  const recovery = path.join(path.dirname(target), `${path.basename(target)}.simplemd-conflict-${randomUUID()}`);
  return renameNoReplace(tmp, recovery).then(() => recovery, () => tmp);
}

export function watchDocument(file: string, changed: () => void, delay = 80): { close(): void } {
  const targets = new Set([path.resolve(file)]);
  try {
    targets.add(fs.realpathSync(file));
  } catch {
    // The directory watcher also handles a file recreated after deletion.
  }
  let timer: NodeJS.Timeout | undefined;
  const watchers = [...targets].map((target) => fs.watch(path.dirname(target), (_event, name) => {
    if (name !== null && String(name) !== path.basename(target)) return;
    clearTimeout(timer);
    timer = setTimeout(changed, delay);
  }));
  return { close() { clearTimeout(timer); watchers.forEach((watcher) => watcher.close()); } };
}

// Kept as the existing import point for callers and byte-level tests.
export { saveDocumentImage as saveImageNextTo } from "./image-store.js";

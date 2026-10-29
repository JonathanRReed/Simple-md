import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyMetadata } from "./file-metadata.js";

export const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx", ".txt"]);
export const isMarkdown = (p: string) => MARKDOWN_EXT.has(path.extname(p).toLowerCase());

export class FileConflictError extends Error {
  constructor() {
    super("The note changed on disk. Reload it or choose Keep mine before saving.");
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

export async function readRegularFile(file: string, maxBytes = MAX_DOCUMENT_BYTES): Promise<Buffer> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
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
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
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

export async function writeAtomic(file: string, text: string, expectedText?: string | null): Promise<void> {
  const entry = await fs.promises.lstat(file).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  });
  const target = entry?.isSymbolicLink() ? await fs.promises.realpath(file) : file;
  const stat = entry?.isSymbolicLink() ? await fs.promises.stat(target) : entry;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    // Reject encoded/binary files even if the caller did not supply a disk revision.
    if (stat) await readDiskText(target);
    const handle = await fs.promises.open(tmp, "wx", stat ? stat.mode & 0o7777 : 0o666);
    try {
      if (stat && process.platform === "darwin") {
        // Losing tags or xattrs is better than losing the save.
        await copyMetadata(target, tmp).catch((err) => console.error("simplemd: could not preserve file metadata", err));
      }
      await handle.truncate(0);
      await handle.writeFile(text, "utf8");
      if (stat) await handle.chmod(stat.mode & 0o7777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      if (expectedText !== undefined && (await readDiskText(target)) !== expectedText) throw new FileConflictError();
      if (entry?.isSymbolicLink() && (await fs.promises.realpath(file)) !== target) throw new FileConflictError();
      if (!entry?.isSymbolicLink()) {
        const latest = await fs.promises.lstat(file).catch((err: unknown) => {
          if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
          throw err;
        });
        if (latest?.isSymbolicLink()) throw new FileConflictError();
      }
      try { await fs.promises.rename(tmp, target); break; }
      catch (err) {
        // Windows can hold the destination briefly during concurrent renames.
        // Recheck the disk revision and symlinks after each bounded delay.
        if (process.platform !== "win32" || attempt >= 5 || !(err instanceof Error && "code" in err && ["EPERM", "EACCES", "EBUSY"].includes(String(err.code)))) throw err;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
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

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);

/** Stores a pasted or dropped image beside the document and returns the relative path to link. */
export async function saveImageNextTo(docPath: string, bytes: Uint8Array, ext: string): Promise<string | null> {
  const safeExt = ext.toLowerCase().replace(/^\./, "");
  if (!IMAGE_EXT.has(safeExt)) return null;
  const dir = path.join(path.dirname(docPath), "assets");
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  for (let i = 0; i < 100; i++) {
    const name = `image-${stamp}${i ? `-${i}` : ""}.${safeExt}`;
    try {
      await fs.promises.writeFile(path.join(dir, name), bytes, { flag: "wx" });
      return `assets/${name}`;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
  }
  return null;
}

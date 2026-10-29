import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyMetadata } from "./file-metadata.js";

export const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx", ".txt"]);
// Space in the file manager only claims real Markdown; .txt stays with Quick Look.
const PEEK_EXT = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);
export const isPeekable = (p: string) => PEEK_EXT.has(path.extname(p).toLowerCase());
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

export async function readDocument(file: string) {
  return decodeDocument(await fs.promises.readFile(file));
}

export async function readDiskText(file: string): Promise<string | null> {
  try {
    const doc = await readDocument(file);
    if (doc.readOnlyReason) throw new FileEncodingError();
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
    if (expectedText !== undefined && (await readDiskText(target)) !== expectedText) throw new FileConflictError();
    if (entry?.isSymbolicLink() && (await fs.promises.realpath(file)) !== target) throw new FileConflictError();
    if (!entry?.isSymbolicLink()) {
      const latest = await fs.promises.lstat(file).catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
        throw err;
      });
      if (latest?.isSymbolicLink()) throw new FileConflictError();
    }
    await fs.promises.rename(tmp, target);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
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

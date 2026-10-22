import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

export async function readDiskText(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, "utf8");
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
    const handle = await fs.promises.open(tmp, "wx", stat ? stat.mode & 0o777 : 0o666);
    try {
      await handle.writeFile(text, "utf8");
      if (stat) await handle.chmod(stat.mode & 0o777);
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

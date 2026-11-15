import fs from "node:fs/promises";
import path from "node:path";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { RenderedBlock } from "../shared/render-core.js";
import { ENCODING_NOTICE } from "./files.js";

export function cliFileError(file: string, error: unknown): Error {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return new Error(`File does not exist: ${file}`);
  if (code === "EACCES" || code === "EPERM") return new Error(`Permission denied: ${file}`);
  if (code === "EISDIR") return new Error(`Cannot open a directory: ${file}`);
  if (error instanceof Error && error.message === ENCODING_NOTICE) return new Error(`Binary or invalid UTF-8 file: ${file}`);
  return error instanceof Error ? error : new Error(String(error));
}
export function requireHeading(blocks: RenderedBlock[], slug: string): void {
  const id = `user-content-${slug}`;
  const contains = (node: DefaultTreeAdapterMap["node"]): boolean => {
    if ("tagName" in node && /^h[1-6]$/.test(node.tagName) && node.attrs.some(attr => attr.name === "id" && attr.value === id)) return true;
    return "childNodes" in node && node.childNodes.some(contains);
  };
  if (!blocks.some(block => contains(parseFragment(block.html)))) throw new Error(`Heading not found: #${slug}`);
}

export async function cliOpenTarget(file: string, create: boolean): Promise<{ kind: "file" | "draft"; path: string }> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("Only regular files can be opened.");
    return { kind: "file", path: file };
  } catch (error) {
    if (!create || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw cliFileError(file, error);
    // A dangling symlink is not a new document destination.
    if (await fs.lstat(file).then(() => true, () => false)) throw new Error("The destination is a symbolic link.", { cause: error });
    const folder = await fs.realpath(path.dirname(file));
    if (!(await fs.stat(folder)).isDirectory()) throw new Error("The parent folder does not exist.", { cause: error });
    return { kind: "draft", path: path.join(folder, path.basename(file)) };
  }
}

export async function openCliBatch<T>(files: readonly T[], open: (file: T, closed: () => void) => Promise<(() => void) | undefined>, closed: () => void): Promise<() => void> {
  const removers: (() => void)[] = [];
  let remaining = files.length, accepted = false;
  const done = () => { if (--remaining === 0 && accepted) closed(); };
  let failed = false, failure: unknown;
  for (const file of files) {
    try {
      const remove = await open(file, done);
      if (remove) removers.push(remove);
    } catch (error) { failed = true; failure ??= error; }
  }
  const cleanup = () => removers.forEach(remove => remove());
  if (failed) { cleanup(); throw failure; }
  accepted = true;
  if (!remaining) closed();
  return cleanup;
}

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

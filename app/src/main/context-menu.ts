import type { MenuItemConstructorOptions } from "electron";
import type { NativeContext } from "../shared/native-context.js";
import type { UrlContext } from "../shared/url-resolver.js";
import { resolveAuthorUrl } from "../shared/url-resolver.js";
import { containedLocalFile } from "./document-urls.js";
import { isMarkdown } from "./files.js";

export async function validateContext(input: unknown, urls: UrlContext): Promise<NativeContext> {
  if (!input || typeof input !== "object" || !("selectionPresent" in input) || typeof input.selectionPresent !== "boolean" ||
      !("editable" in input) || typeof input.editable !== "boolean" || !("linkURL" in input) || typeof input.linkURL !== "string" ||
      !("imageURL" in input) || typeof input.imageURL !== "string" || !("misspelledWord" in input) || typeof input.misspelledWord !== "string" ||
      !("suggestions" in input) || !Array.isArray(input.suggestions) || input.suggestions.length > 32 ||
      !input.suggestions.every((s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 256) || input.misspelledWord.length > 256) {
    throw new TypeError("Invalid context menu request.");
  }
  const validateURL = async (url: string, kind: "anchor" | "resource") => {
    if (!url) return "";
    if (url.length > 8192) throw new TypeError("Invalid context URL.");
    if (url.startsWith("file:")) await containedLocalFile(url, urls);
    else if (!/^(https?:|mailto:)/i.test(url) || resolveAuthorUrl(url, kind, urls) === null) throw new TypeError("Invalid context URL.");
    return url;
  };
  return {
    selectionPresent: input.selectionPresent, editable: input.editable,
    linkURL: await validateURL(input.linkURL, "anchor"), imageURL: await validateURL(input.imageURL, "resource"),
    misspelledWord: input.editable ? input.misspelledWord : "",
    suggestions: input.editable ? input.suggestions : [],
  };
}

export interface ContextActions {
  replace(word: string): void;
  dictionary(word: string): void;
  open(url: string, newTab: boolean): void;
  copy(text: string): void;
  reveal(url: string): void;
  lookup(): void;
  share?: () => void;
}
export function contextTemplate(c: NativeContext, a: ContextActions, platform = process.platform): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (c.editable && c.misspelledWord) {
    items.push(...c.suggestions.map(word => ({ label: word, click: () => a.replace(word) })));
    if (!c.suggestions.length) items.push({ label: "No Spelling Suggestions", enabled: false });
    items.push({ label: "Add to Dictionary", click: () => a.dictionary(c.misspelledWord) }, { type: "separator" });
  }
  if (c.linkURL) {
    items.push({ label: "Open Link", click: () => a.open(c.linkURL, false) }, { label: "Copy Link", click: () => a.copy(c.linkURL) });
    if (c.linkURL.startsWith("file:") && isMarkdown(new URL(c.linkURL).pathname)) items.push({ label: "Open in New Tab", click: () => a.open(c.linkURL, true) });
    items.push({ type: "separator" });
  }
  if (c.imageURL) {
    items.push({ label: "Copy Image Address", click: () => a.copy(c.imageURL) });
    if (c.imageURL.startsWith("file:")) items.push({ label: platform === "darwin" ? "Reveal in Finder" : platform === "win32" ? "Reveal in Explorer" : "Show in File Manager", click: () => a.reveal(c.imageURL) });
    items.push({ type: "separator" });
  }
  if (c.editable) items.push({ role: "cut", enabled: c.selectionPresent });
  items.push({ role: "copy", enabled: c.selectionPresent });
  if (c.editable) items.push({ role: "paste" }, { role: "pasteAndMatchStyle", label: "Paste as Plain Text" });
  items.push({ role: "selectAll" });
  if (platform === "darwin" && c.selectionPresent) items.push({ type: "separator" }, { label: "Look Up", click: a.lookup });
  if (platform === "darwin" && a.share) items.push({ type: "separator" }, { label: "Share", click: a.share });
  return items;
}

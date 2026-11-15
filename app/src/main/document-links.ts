import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentId, DocumentLocation, OpenIntent } from "../shared/types.js";
import { linkLocation } from "../shared/link-location.js";
import { resolveAuthorUrl } from "../shared/url-resolver.js";
import { astroRouteFile, containedLocalFile, urlContext } from "./document-urls.js";
import { isMarkdown } from "./files.js";

export async function openDocumentLink(href: string, intent: OpenIntent, newTab: boolean, current: { path: string | null; documentId: DocumentId }, actions: {
  external(url: string): Promise<unknown>;
  open(file: string, intent: OpenIntent, inPlace: boolean, id: DocumentId, location?: DocumentLocation): Promise<boolean>;
}): Promise<boolean> {
  if (/^(https?:|mailto:)/i.test(href)) { await actions.external(href); return false; }
  if (!current.path) return false;
  const urls = urlContext(path.dirname(current.path));
  const resolved = href.startsWith("file:") ? href : resolveAuthorUrl(href, "anchor", urls);
  if (!resolved || !resolved.startsWith("file:")) return false;
  try {
    const route = await astroRouteFile(resolved, urls);
    if (route) return actions.open(route, intent, !newTab, current.documentId, linkLocation(resolved));
    const canonical = await containedLocalFile(resolved, urls);
    const target = fileURLToPath(resolved);
    return isMarkdown(target) && isMarkdown(canonical) ? actions.open(target, intent, !newTab, current.documentId, linkLocation(resolved)) : false;
  } catch { return false; }
}

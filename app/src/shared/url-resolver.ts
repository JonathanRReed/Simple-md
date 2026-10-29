import { prefixFragment } from "./sanitizer-policy.js";

export interface UrlContext {
  baseUrl?: string;
  rootUrl?: string;
}
export type UrlKind = "anchor" | "resource";

// Input is decoded by the Markdown or HTML parser before reaching this boundary.
export function resolveAuthorUrl(input: string, kind: UrlKind, context: UrlContext = {}, remoteImages = true): string | null {
  const value = input.trim();
  // Browsers ignore these characters inside schemes. Reject rather than repair them.
  if (!value || /[\u0000-\u0020\u007f-\u009f\\]/.test(value.replace(/ /g, ""))) return null;
  if (value.startsWith("#")) return kind === "anchor" ? value : null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  const remote = (url: URL) => (url.protocol === "https:" || url.protocol === "http:") && (kind === "anchor" || remoteImages);
  if (scheme || value.startsWith("//")) {
    if (scheme !== undefined && scheme !== "http" && scheme !== "https" && !(kind === "anchor" && scheme === "mailto")) return null;
    try {
      const url = new URL(value, "https://relative.invalid/");
      if (kind === "resource" && remote(url) && url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/blob\//.test(url.pathname)) {
        url.pathname = url.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/raw/");
        return url.href;
      }
      return remote(url) || (kind === "anchor" && url.protocol === "mailto:") ? (value.startsWith("//") ? url.href : value) : null;
    } catch { return null; }
  }
  const base = value.startsWith("/") ? context.rootUrl : context.baseUrl;
  if (!base) return value;
  try {
    const url = new URL(value.startsWith("/") ? value.slice(1) : value, base);
    // file: is minted here only for relative source paths. Author file: never reaches here.
    if (url.protocol === "file:") return url.href;
    return remote(url) ? url.href : null;
  } catch { return null; }
}

export interface SrcsetCandidate { url: string; descriptor: string }

function validDescriptors(descriptor: string): boolean {
  let width = false;
  let density = false;
  let height = false;
  for (const part of descriptor.split(/[\t\n\f\r ]+/).filter(Boolean)) {
    if (/^\d+w$/.test(part) && Number.parseInt(part) > 0 && !width && !density) width = true;
    else if (/^\d+h$/.test(part) && Number.parseInt(part) > 0 && !height && !density) height = true;
    else if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?x$/.test(part) &&
        Number.isFinite(Number.parseFloat(part)) && Number.parseFloat(part) >= 0 && !width && !density && !height) density = true;
    else return false;
  }
  return !height || width;
}

// WHATWG candidate collection: commas inside a URL belong to the URL; trailing
// commas delimit a descriptor-free candidate. Parentheses protect descriptor commas.
export function parseSrcset(input: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /[\t\n\f\r ,]/.test(input[i]!)) i++;
    const start = i;
    while (i < input.length && !/[\t\n\f\r ]/.test(input[i]!)) i++;
    let url = input.slice(start, i);
    if (!url) break;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      if (url) candidates.push({ url, descriptor: "" });
      continue;
    }
    const descriptorStart = i;
    let parentheses = 0;
    while (i < input.length) {
      const char = input[i++]!;
      if (char === "(") parentheses++;
      else if (char === ")") parentheses = Math.max(0, parentheses - 1);
      else if (char === "," && !parentheses) break;
    }
    const descriptor = input.slice(descriptorStart, input[i - 1] === "," ? i - 1 : i).trim();
    if (validDescriptors(descriptor)) candidates.push({ url, descriptor });
  }
  return candidates;
}

export function resolveSrcset(input: string, context: UrlContext = {}, remoteImages = true): string | null {
  const resolved = parseSrcset(input).flatMap(({ url, descriptor }) => {
    const value = resolveAuthorUrl(url, "resource", context, remoteImages);
    return value === null ? [] : [value + (descriptor ? ` ${descriptor}` : "")];
  });
  return resolved.length ? resolved.join(", ") : null;
}

export function resolveFragment(fragment: string, fragments: ReadonlyMap<string, string> = new Map()): string {
  let id = fragment.replace(/^#/, "");
  try { id = decodeURIComponent(id); } catch { /* Keep malformed escapes literal. */ }
  return "#" + (fragments.get(id) ?? prefixFragment(id));
}

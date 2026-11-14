import type { DocumentLocation } from "./types.js";
export function linkLocation(href: string): DocumentLocation | undefined {
  const hash = href.indexOf("#");
  if (hash < 0 || hash === href.length - 1) return undefined;
  try { return { kind: "heading", heading: decodeURIComponent(href.slice(hash + 1)) }; }
  catch { return undefined; }
}

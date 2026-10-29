import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { UrlContext } from "../shared/url-resolver.js";

export function urlContext(baseDir: string | undefined, discoverRoot = true): UrlContext {
  if (!baseDir) return {};
  const folder = (dir: string) => pathToFileURL(path.resolve(dir) + path.sep).href;
  if (!discoverRoot) return { baseUrl: folder(baseDir) };
  let ancestor = path.resolve(baseDir);
  let git: string | undefined;
  let root: string | undefined;
  while (true) {
    try {
      const entries = fs.readdirSync(ancestor);
      if (entries.some((name) => /^astro\.config\./.test(name) && fs.statSync(path.join(ancestor, name)).isFile())) {
        root = path.join(ancestor, "public");
        break;
      }
      if (!git && entries.includes(".git")) git = ancestor;
    } catch { /* A missing directory may still have a project ancestor. */ }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return { baseUrl: folder(baseDir), ...(root || git ? { rootUrl: folder(root ?? git!) } : {}) };
}


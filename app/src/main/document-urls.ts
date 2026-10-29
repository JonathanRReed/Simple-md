import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isContainedFileUrl, type UrlContext } from "../shared/url-resolver.js";

const roots = new Map<string, { expires: number; context: UrlContext }>();
const ROOT_TTL_MS = 2000;
export function invalidateUrlContext(baseDir: string): void { roots.delete(path.resolve(baseDir)); }

export function urlContext(baseDir: string | undefined, _discoverRoot = true): UrlContext {
  if (!baseDir) return {};
  const folder = (dir: string) => pathToFileURL(path.resolve(dir) + path.sep).href;
  baseDir = path.resolve(baseDir);
  const cached = roots.get(baseDir);
  if (cached && cached.expires > Date.now()) return cached.context;
  let ancestor = path.resolve(baseDir);
  let git: string | undefined;
  let root: string | undefined;
  while (true) {
    try {
      const entries = fs.readdirSync(ancestor);
      if (entries.includes("public") && fs.statSync(path.join(ancestor, "public")).isDirectory() &&
          entries.some((name) => /^astro\.config\./.test(name) && fs.statSync(path.join(ancestor, name)).isFile())) {
        root = path.join(ancestor, "public");
        break;
      }
      if (!git && entries.includes(".git")) git = ancestor;
    } catch { /* A missing directory may still have a project ancestor. */ }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const context = { baseUrl: folder(baseDir), ...(root || git ? { rootUrl: folder(root ?? git!) } : {}) };
  if (roots.size >= 128) roots.delete(roots.keys().next().value!);
  roots.set(baseDir, { expires: Date.now() + ROOT_TTL_MS, context });
  return context;
}


export async function containedLocalFile(url: string, context: UrlContext): Promise<string> {
  if (!isContainedFileUrl(url, context)) throw new Error("Local file is outside the document root.");
  const [file, root] = await Promise.all([
    fs.promises.realpath(fileURLToPath(url)),
    fs.promises.realpath(fileURLToPath(context.rootUrl ?? context.baseUrl!)),
  ]);
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Local file is outside the document root.");
  return file;
}

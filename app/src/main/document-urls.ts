import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { containedFileRoot, type UrlContext } from "../shared/url-resolver.js";

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
  let root: string | undefined;
  let publicDir: string | undefined;
  while (true) {
    try {
      const entries = fs.readdirSync(ancestor);
      // A symlink cannot grant access to another directory.
      if (!publicDir && entries.includes("public") && fs.lstatSync(path.join(ancestor, "public")).isDirectory()) publicDir = path.join(ancestor, "public");
      if (entries.includes(".git") || entries.some((name) => /^astro\.config\./.test(name) && fs.lstatSync(path.join(ancestor, name)).isFile())) {
        root = ancestor;
        break;
      }
    } catch { /* A missing directory may still have a project ancestor. */ }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const context = { baseUrl: folder(baseDir), ...(root ? { rootUrl: folder(root) } : {}), ...(publicDir ? { publicUrl: folder(publicDir) } : {}) };
  if (roots.size >= 128) roots.delete(roots.keys().next().value!);
  roots.set(baseDir, { expires: Date.now() + ROOT_TTL_MS, context });
  return context;
}

export async function containedLocalFile(url: string, context: UrlContext): Promise<string> {
  const rootUrl = containedFileRoot(url, context);
  if (!rootUrl) throw new Error("Local file is outside the document root.");
  const [file, root] = await Promise.all([
    fs.promises.realpath(fileURLToPath(url)),
    fs.promises.realpath(fileURLToPath(rootUrl)),
  ]);
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Local file is outside the document root.");
  return file;
}

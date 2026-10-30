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

// Route discovery reads filenames only and never evaluates project configuration.
export async function astroRouteFile(url: string, context: UrlContext): Promise<string | null> {
  if (!context.rootUrl || !containedFileRoot(url, context)) return null;
  try {
    const root = fileURLToPath(context.rootUrl);
    const entries = await fs.promises.readdir(root);
    let astro = false;
    for (const name of entries) if (/^astro\.config\./.test(name) && (await fs.promises.lstat(path.join(root, name))).isFile()) { astro = true; break; }
    if (!astro) return null;
    const target = fileURLToPath(url);
    const base = context.publicUrl ?? context.rootUrl;
    const route = path.relative(fileURLToPath(base), target);
    if (route === ".." || route.startsWith(".." + path.sep) || path.isAbsolute(route) || path.extname(route)) return null;
    const parts = route.split(path.sep).filter(Boolean);
    const locations = [path.join(root, "src/pages", ...parts)];
    if (parts.length >= 2) locations.unshift(path.join(root, "src/content", ...parts));
    for (const location of locations) for (const suffix of [".md", ".mdx", "/index.md", "/index.mdx"]) {
      const candidate = pathToFileURL(location + suffix).href;
      try {
        const canonical = await containedLocalFile(candidate, { rootUrl: context.rootUrl });
        if (/\.(md|mdx)$/i.test(canonical) && (await fs.promises.stat(canonical)).isFile()) return canonical;
      } catch { /* Missing routes and symlinks outside the project grant no access. */ }
    }
  } catch { /* An unavailable project is not a local route. */ }
  return null;
}

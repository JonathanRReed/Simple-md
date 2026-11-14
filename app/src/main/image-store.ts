import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { containedLocalFile, urlContext } from "./document-urls.js";
import { containedFileRoot, resolveAuthorUrl } from "../shared/url-resolver.js";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
const encodePath = (value: string) => value.split(/[\\/]/).map(part => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");

/** Canonical containment is checked before creating each directory, including symlink ancestors. */
export async function saveDocumentImage(docPath: string, bytes: Uint8Array, ext: string, folder = "assets"): Promise<string | null> {
  docPath = await fs.realpath(docPath);
  ext = ext.toLowerCase().replace(/^\./, "");
  if (!IMAGE_EXTENSIONS.includes(ext)) return null;
  if (!folder || path.isAbsolute(folder) || folder.includes("\\") || folder.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(folder)) throw new Error("Choose an image folder inside the document root.");
  const context = urlContext(path.dirname(docPath));
  const root = await fs.realpath(fileURLToPath(context.rootUrl ?? context.baseUrl!));
  const publicFolder = folder.startsWith("public/") && context.publicUrl;
  const base = publicFolder ? fileURLToPath(context.publicUrl!) : path.dirname(docPath);
  const relative = publicFolder ? folder.slice(7) : folder;
  const destination = path.resolve(base, relative);
  const authorPath = publicFolder ? "/" + encodePath(relative) : encodePath(folder);
  const resolved = resolveAuthorUrl(authorPath + "/placeholder.png", "resource", context);
  if (!resolved || !containedFileRoot(resolved, context) || !inside(root, destination)) throw new Error("The image folder is outside the document root.");
  let directory = root;
  for (const part of path.relative(root, destination).split(path.sep).filter(Boolean)) {
    const next = path.join(directory, part);
    const existing = await fs.lstat(next).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) await fs.mkdir(next).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    const canonical = await fs.realpath(next);
    if (!inside(root, canonical) || !(await fs.stat(canonical)).isDirectory()) throw new Error("The image folder is outside the document root.");
    directory = canonical;
  }
  const stem = path.basename(docPath, path.extname(docPath)).replace(/[^\p{L}\p{N}_.-]+/gu, "-") || "image";
  const stamp = Date.now().toString(36);
  for (let i = 0; i < 1000; i++) {
    const name = `${stem}-${stamp}${i ? `-${i}` : ""}.${ext}`;
    try {
      await fs.writeFile(path.join(directory, name), bytes, { flag: "wx" });
      return authorPath + "/" + encodePath(name);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  throw new Error("Could not choose an unused image name.");
}
export async function insertDocumentImage(docPath: string, imagePath: string, folder = "assets"): Promise<string | null> {
  docPath = await fs.realpath(docPath);
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) return null;
  const image = await fs.realpath(imagePath);
  if (!(await fs.stat(image)).isFile()) return null;
  const context = urlContext(path.dirname(docPath));
  const root = await fs.realpath(fileURLToPath(context.rootUrl ?? context.baseUrl!));
  if (inside(root, image)) {
    await containedLocalFile(pathToFileURL(image).href, context);
    const relative = encodePath(path.relative(path.dirname(docPath), image));
    if (resolveAuthorUrl(relative, "resource", context)) return relative;
  }
  return saveDocumentImage(docPath, new Uint8Array(await fs.readFile(image)), ext, folder);
}

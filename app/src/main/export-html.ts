import path from "node:path";
import { containedLocalFile } from "./document-urls.js";
import { readRegularFile } from "./files.js";
import type { UrlContext } from "../shared/url-resolver.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
};

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export async function embedLocalImages(sources: string[], context: UrlContext, warn: (message: string) => void = console.warn): Promise<string[]> {
  return Promise.all(sources.map(async (source) => {
    if (!source.startsWith("file:")) return source;
    try {
      const file = await containedLocalFile(source, context);
      const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
      if (!mime) throw new Error(`Cannot embed this image format: ${path.extname(file)}`);
      return `data:${mime};base64,${(await readRegularFile(file, MAX_IMAGE_BYTES)).toString("base64")}`;
    } catch (error) {
      warn(`simplemd: skipped export image: ${source}: ${error instanceof Error ? error.message : String(error)}`);
      return source;
    }
  }));
}

export async function embedKatexFonts(css: string, readFont: (relativePath: string) => Promise<Buffer>): Promise<string> {
  const paths = new Set([...css.matchAll(/url\(["']?(fonts\/[^)"']+\.(?:woff2|woff|ttf))["']?\)/g)].map((match) => match[1]!));
  const fonts = new Map(await Promise.all([...paths].map(async (relativePath) => {
    const mime = relativePath.endsWith("woff2") ? "font/woff2" : relativePath.endsWith("woff") ? "font/woff" : "font/ttf";
    const data = await readFont(relativePath);
    return [relativePath, `url(data:${mime};base64,${data.toString("base64")})`] as const;
  })));
  return css.replace(/url\(["']?(fonts\/[^)"']+\.(?:woff2|woff|ttf))["']?\)/g, (url, relativePath: string) => fonts.get(relativePath) ?? url);
}

export const EXPORT_LIGHT_THEME = `
:root { color-scheme: light; --bg: #fff; --fg: #242426; --muted: #65656b; --rule: #dedee2; --accent: #315cc5; --code-bg: #f2f2f4; --tok-keyword: #cf222e; --tok-string: #0a3069; --tok-number: #0550ae; --tok-comment: #6e7781; --tok-name: #8250df; --tok-type: #953800; }
body { background: var(--bg); color: var(--fg); }
.shiki, .shiki span { color: var(--shiki-light) !important; background-color: var(--shiki-light-bg) !important; }
`;

import type { Token } from "markdown-it";
import { createMarkdownParser } from "./markdown-parser.js";

export function splitFrontmatter(src: string): { body: string; raw?: string } {
  const m = /^---(?:\r\n|[\r\n])([\s\S]*?)(?:\r\n|[\r\n])---(?:(?:\r\n|[\r\n])|$)/.exec(src);
  if (!m) return { body: src };
  return { body: src.slice(m[0].length), raw: m[1] };
}

// YAML loads only for documents with frontmatter, keeping it out of plain renders.
export async function documentTitle(source: string, filename: string | null, parsed?: Token[]): Promise<string> {
  const { raw, body } = splitFrontmatter(source.replace(/^\uFEFF/, ""));
  if (raw !== undefined) {
    try {
      const { parseDocument } = await import("yaml");
      const doc = parseDocument(raw, { schema: "core", uniqueKeys: true });
      const title: unknown = doc.errors.length ? undefined : doc.get("title");
      if ((typeof title === "string" || typeof title === "number") && String(title).trim()) return String(title).trim();
    } catch { /* Invalid metadata falls back to the heading or filename. */ }
  }
  const tokens = parsed ?? createMarkdownParser().parse(body, {});
  const heading = tokens.findIndex(token => token.type === "heading_open" && token.tag === "h1");
  const inline = heading < 0 ? undefined : tokens[heading + 1];
  const text = inline?.children?.filter(token => ["text", "code_inline", "image", "math_inline"].includes(token.type)).map(token => token.content).join("").trim();
  return text || (filename ? filename.split(/[/\\]/).pop()!.replace(/\.[^.]*$/, "") : "Untitled");
}

export function exportFilename(title: string, format: "html" | "pdf"): string {
  return `${(title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim() || "Untitled").slice(0, 120)}.${format}`;
}

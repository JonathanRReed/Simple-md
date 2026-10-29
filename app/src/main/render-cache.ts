import { isRenderedBlock } from "../shared/render-tree.js";
import { perfMark } from "./perf.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import electron from "electron";
import type { RenderedBlock, RenderedBlocks } from "./markdown.js";

interface CacheEntry extends RenderedBlocks {
  mtimeMs: number;
  size: number;
  sourceHash: string;
}

export const RENDER_CACHE_VERSION = 4;
const MAX_ENTRIES = 24;
const MAX_BYTES = 16 * 1024 * 1024;
const ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ version: RENDER_CACHE_VERSION, entries: {} }));
const sourceHash = (text: string) => {
  perfMark("hash-start");
  const hash = createHash("sha256").update(text).digest("hex");
  perfMark("hash-end");
  return hash;
};

function isEntry(value: unknown): value is CacheEntry {
  return typeof value === "object" && value !== null &&
    "mtimeMs" in value && typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs) &&
    "size" in value && typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0 &&
    "sourceHash" in value && typeof value.sourceHash === "string" && /^[a-f0-9]{64}$/.test(value.sourceHash) &&
    "title" in value && typeof value.title === "string" &&
    "blocks" in value && Array.isArray(value.blocks) && value.blocks.every(isRenderedBlock);
}

export class RenderCache {
  private entries: Map<string, { entry: CacheEntry; bytes: number }> | undefined;
  private bytes = ENVELOPE_BYTES;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly file: string, private readonly maxBytes = MAX_BYTES) {}

  private load(): Map<string, { entry: CacheEntry; bytes: number }> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      if (fs.statSync(this.file).size > this.maxBytes) return this.entries;
      const data: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof data !== "object" || data === null || !("version" in data) ||
          data.version !== RENDER_CACHE_VERSION || !("entries" in data) ||
          typeof data.entries !== "object" || data.entries === null || Array.isArray(data.entries)) return this.entries;
      for (const [key, entry] of Object.entries(data.entries)) {
        if (!isEntry(entry)) continue;
        this.insert(key, entry);
      }
    } catch {
      // Cache loss costs one render and must not prevent opening a document.
    }
    return this.entries;
  }

  private insert(filePath: string, entry: CacheEntry): void {
    const map = this.entries!;
    const previous = map.get(filePath);
    if (previous) this.bytes -= previous.bytes;
    map.delete(filePath);
    const bytes = Buffer.byteLength(JSON.stringify({ [filePath]: entry })) - 1;
    if (bytes + ENVELOPE_BYTES > this.maxBytes) return;
    map.set(filePath, { entry, bytes });
    this.bytes += bytes;
    while (map.size > MAX_ENTRIES || this.bytes > this.maxBytes) {
      const oldest = map.entries().next();
      if (oldest.done) break;
      this.bytes -= oldest.value[1].bytes;
      map.delete(oldest.value[0]);
    }
  }

  get(filePath: string, mtimeMs: number, size: number, text: string): RenderedBlocks | null {
    const map = this.load();
    const hit = map.get(filePath);
    if (!hit || hit.entry.mtimeMs !== mtimeMs || hit.entry.size !== size || hit.entry.sourceHash !== sourceHash(text)) return null;
    map.delete(filePath);
    map.set(filePath, hit);
    return { title: hit.entry.title, blocks: hit.entry.blocks };
  }

  set(filePath: string, mtimeMs: number, size: number, title: string, blocks: RenderedBlock[], text: string): void {
    this.load();
    this.insert(filePath, { mtimeMs, size, title, blocks, sourceHash: sourceHash(text) });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 400);
    this.saveTimer.unref();
  }

  flush(): void {
    clearTimeout(this.saveTimer);
    if (!this.entries) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const entries = Object.fromEntries([...this.entries].map(([key, value]) => [key, value.entry]));
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: RENDER_CACHE_VERSION, entries }));
      fs.renameSync(temp, this.file);
    } catch {
      // Read-only profiles can still open and edit documents without a disk cache.
    }
  }
}

let cache: RenderCache | undefined;
const diskCache = () => cache ??= new RenderCache(path.join(electron.app.getPath("userData"), "render-cache.json"));

export function getCachedRender(filePath: string, mtimeMs: number, size: number, text: string): RenderedBlocks | null {
  return diskCache().get(filePath, mtimeMs, size, text);
}

export function setCachedRender(filePath: string, mtimeMs: number, size: number, title: string, blocks: RenderedBlock[], text: string): void {
  diskCache().set(filePath, mtimeMs, size, title, blocks, text);
}

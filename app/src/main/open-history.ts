import type { QuicklyFile } from "../shared/open-quickly.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export interface OpenedPath { path: string; lastOpened: number }
export function parseHistory(raw: unknown): OpenedPath[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.filter((entry): entry is OpenedPath => entry !== null && typeof entry === "object" &&
    "path" in entry && typeof entry.path === "string" && path.isAbsolute(entry.path) && !entry.path.includes("\0") &&
    "lastOpened" in entry && typeof entry.lastOpened === "number" && Number.isFinite(entry.lastOpened) && entry.lastOpened >= 0)
    .sort((a, b) => b.lastOpened - a.lastOpened).filter(entry => {
      if (seen.has(entry.path)) return false;
      seen.add(entry.path); return true;
    }).slice(0, 100);
}
/** Loaded on the first history query, after the initial document has painted. */
export class OpenHistory {
  private entries?: OpenedPath[];
  private pending = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  constructor(private readonly file: string) {}
  private load(): OpenedPath[] {
    if (!this.entries) {
      try { this.entries = parseHistory(JSON.parse(fs.readFileSync(this.file, "utf8"))); } catch { this.entries = []; }
      this.entries = parseHistory([...this.pending].map(([path, lastOpened]) => ({ path, lastOpened })).concat(this.entries));
      this.pending.clear();
    }
    return this.entries;
  }
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150); this.timer.unref();
  }
  opened(file: string, now = Date.now()): void {
    if (this.entries) this.entries = [{ path: file, lastOpened: now }, ...this.entries.filter(entry => entry.path !== file)].slice(0, 100);
    else this.pending.set(file, now);
    this.schedule();
  }
  async searchFiles(recents: readonly string[]): Promise<QuicklyFile[]> {
    const entries = this.load();
    const seen = new Set(entries.map(entry => entry.path));
    return availableHistoryFiles([...entries.map(entry => ({ ...entry, source: "recent" as const })), ...recents.flatMap(file => {
      if (seen.has(file)) return [];
      seen.add(file);
      return [{ path: file, source: "recent" as const }];
    })]);
  }
  moved(previous: string, target: string): void {
    this.entries = this.load().filter(entry => entry.path !== target).map(entry => entry.path === previous ? { ...entry, path: target } : entry);
    this.schedule();
  }
  clear(): void { this.entries = []; this.pending.clear(); this.flush(); }
  flush(): void {
    clearTimeout(this.timer);
    if (!this.entries && !this.pending.size) return;
    const entries = this.load();
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(entries), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) { fs.rmSync(temporary, { force: true }); console.error("simplemd: could not save opened-file history", error); }
  }
}

export async function availableHistoryFiles<T extends { path: string }>(files: readonly T[], check = (file: string) => fs.promises.stat(file).then(stat => stat.isFile(), () => false), timeout = 150): Promise<T[]> {
  const available = await Promise.all(files.map(async file => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([check(file.path), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), timeout); })]);
    } finally { clearTimeout(timer); }
  }));
  return files.filter((_, index) => available[index]);
}

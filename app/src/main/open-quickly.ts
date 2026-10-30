import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { git } from "./git-runner.js";
import { MARKDOWN_EXTENSIONS, QUICKLY_CANDIDATE_LIMIT, QUICKLY_LIMIT, markdownPath, quicklyCandidate, quicklyMatches, type QuicklyFile, type QuicklyMatch, type QuicklyScope } from "../shared/open-quickly.js";
import { insertRankedSearchResult, normalizeSearchQuery, type RankedSearchResult } from "../shared/search-ranking.js";

const OUTPUT_BYTES = 8 * 1024 * 1024;
export async function walkMarkdown(root: string, signal: AbortSignal, limits = { depth: 6, entries: 20000 }): Promise<string[]> {
  const files: string[] = [];
  let entries = 0;
  async function walk(folder: string, depth: number): Promise<void> {
    signal.throwIfAborted();
    let dir;
    try { dir = await fs.opendir(folder); } catch { return; }
    for await (const entry of dir) {
      signal.throwIfAborted();
      if (++entries > limits.entries) break;
      const file = path.join(folder, entry.name);
      if (entry.isFile() && markdownPath(file)) files.push(file);
      else if (entry.isDirectory() && depth < limits.depth && !entry.name.startsWith(".") && entry.name !== "node_modules" && !entry.name.endsWith(".app")) await walk(file, depth + 1);
      if (entries >= limits.entries) break;
    }
  }
  await walk(root, 0);
  return files;
}
export async function repoMarkdown(activeFile: string | null, signal: AbortSignal, onRoot?: (root: string) => void): Promise<string[]> {
  if (!activeFile) return [];
  const canonical = await fs.realpath(activeFile).catch(() => null);
  signal.throwIfAborted();
  if (!canonical) return [];
  const folder = path.dirname(canonical);
  let root: string;
  try { root = (await git(["rev-parse", "--show-toplevel"], folder, { signal })).trimEnd(); }
  catch { signal.throwIfAborted(); onRoot?.(folder); return walkMarkdown(folder, signal); }
  onRoot?.(root);
  try {
    const output = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...MARKDOWN_EXTENSIONS.map(ext => `:(icase)*.${ext}`)], root, { signal, timeout: 10000, maxBuffer: OUTPUT_BYTES });
    signal.throwIfAborted();
    return output.split("\0").filter(file => file && markdownPath(file)).map(file => path.resolve(root, file)).filter(file => {
      const relative = path.relative(root, file);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
  } catch { signal.throwIfAborted(); return []; }
}

export function spotlightArgs(rawQuery: string): string[] {
  // Spotlight has its own query language. Escape its literals and wildcard metacharacters.
  const literal = [...rawQuery.trim()].map(char => char.replace(/[\\"*?]/g, char => `\\${char}`)).join("*").replace(/[\x00-\x1f\x7f]/g, " ");
  const types = ['kMDItemContentTypeTree == "net.daringfireball.markdown"', ...MARKDOWN_EXTENSIONS.map(ext => `kMDItemFSName == "*.${ext}"cd`)];
  return ["-0", "-onlyin", os.homedir(), `(${types.join(" || ")})${rawQuery.trim().length >= 2 ? ` && kMDItemFSName == "*${literal}*"cd` : ""}`];
}
export function machinePathAllowed(file: string, home = os.homedir()): boolean {
  if (!path.isAbsolute(file) || !markdownPath(file)) return false;
  const relative = path.relative(path.join(home, "Library"), file);
  if (relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return false;
  return !file.split(/[\\/]/).some(part => /\.app$/i.test(part) || /^(caches?|node_modules|\.git)$/i.test(part));
}
export function searchEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export type SearchSpawner = typeof spawn;
/** Stream bounded, NUL-delimited paths. Never invoke a shell or read file contents. */
export function indexedPaths(command: string, args: string[], signal: AbortSignal, spawner: SearchSpawner = spawn): Promise<string[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawner(command, args, { shell: false, env: searchEnvironment(), stdio: ["ignore", "pipe", "ignore"] });
    const files: string[] = [];
    let pending = Buffer.alloc(0), bytes = 0, finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      if (error) reject(error); else resolve(files);
    };
    const abort = () => finish(new Error("Search cancelled"));
    const timer = setTimeout(() => finish(), 10000);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", error => finish(error));
    child.on("close", () => finish());
    child.stdout?.on("data", (chunk: Buffer) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTES) { finish(); return; }
      pending = Buffer.concat([pending, chunk]);
      let at: number;
      while ((at = pending.indexOf(0)) >= 0) {
        const file = pending.subarray(0, at).toString("utf8"); pending = pending.subarray(at + 1);
        if (machinePathAllowed(file)) files.push(file);
        if (files.length >= QUICKLY_CANDIDATE_LIMIT) { finish(); return; }
      }
    });
    if (signal.aborted) abort();
  });
}
export async function machineMarkdown(query: string, signal: AbortSignal, platform: NodeJS.Platform = process.platform, spawner: SearchSpawner = spawn): Promise<string[]> {
  if (platform === "win32") return [];
  if (platform === "darwin") return indexedPaths("/usr/bin/mdfind", spotlightArgs(query), signal, spawner).catch(() => []);
  if (platform !== "linux") return [];
  // locate queries its existing database. It never starts updatedb or walks the filesystem.
  const literal = query.trim().length >= 2 ? [...query.trim()].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, char => `\\${char}`)).join("[^/]*") : "";
  const expression = `[^/]*${literal}[^/]*\\.(${MARKDOWN_EXTENSIONS.join("|")})$`;
  for (const command of ["plocate", "locate"]) {
    try { return await indexedPaths(command, ["-0", "-i", "--regex", "--", expression], signal, spawner); }
    catch { signal.throwIfAborted(); }
  }
  return [];
}
export class QuicklySearch {
  private controller?: AbortController;
  private repo?: string[];
  private repoRoot?: string;
  constructor(private readonly activeFile: string | null, private readonly sources = { repo: repoMarkdown, machine: machineMarkdown }) {}
  cancel(): void { this.controller?.abort(); this.controller = undefined; }
  close(): void { this.cancel(); this.repo = undefined; this.repoRoot = undefined; }
  async search(query: string, scope: QuicklyScope, instant: QuicklyFile[], publish: (matches: QuicklyMatch[]) => void = () => {}): Promise<QuicklyMatch[]> {
    this.cancel();
    const controller = new AbortController(); this.controller = controller;
    const { signal } = controller;
    const normalized = normalizeSearchQuery(query).replaceAll("\\", "/");
    const rank = async (groups: QuicklyFile[][]) => {
      const seen = new Set<string>();
      const ranked: RankedSearchResult<QuicklyFile>[] = [];
      let i = 0;
      for (const group of groups) for (const file of group) {
        if (i % 512 === 0) { await yieldTurn(); signal.throwIfAborted(); }
        i++;
        if (!markdownPath(file.path)) continue;
        const key = process.platform === "win32" ? file.path.replaceAll("\\", "/").toLowerCase() : file.path;
        if (seen.has(key)) continue;
        seen.add(key);
        const root = this.repoRoot;
        const relative = root ? path.relative(root, file.path) : undefined;
        const inRepo = relative !== undefined && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        const candidate = quicklyCandidate({ ...file, matchPath: inRepo ? relative : scope === "repo" ? path.basename(file.path) : file.path }, normalized, i);
        if (candidate) insertRankedSearchResult(ranked, candidate, QUICKLY_LIMIT);
      }
      return quicklyMatches(ranked, normalized);
    };
    try {
      const machinePromise = scope === "everywhere" ? this.sources.machine(query, signal).catch(() => []) : Promise.resolve([]);
      const repo = this.repo ?? await this.sources.repo(this.activeFile, signal, root => { this.repoRoot = root; });
      signal.throwIfAborted(); this.repo = repo;
      const local: QuicklyFile[][] = [instant, repo.map(path => ({ path, source: "repo" }))];
      const matches = await rank(local);
      if (scope === "repo") return matches;
      publish(matches);
      const machine = await machinePromise;
      signal.throwIfAborted();
      return machine.length ? await rank([...local, machine.map(path => ({ path, source: "machine" }))]) : matches;
    } catch { controller.abort(); return []; }
  }
}

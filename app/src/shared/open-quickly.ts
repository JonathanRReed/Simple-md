import { findMatchIndices, insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from "./search-ranking.js";

export type QuicklyScope = "repo" | "everywhere";
export const MARKDOWN_EXTENSIONS = ["md", "mdx", "markdown", "mdown", "mkd"] as const;
export const QUICKLY_LIMIT = 200;
export interface QuicklyFile { path: string; source: "tab" | "recent" | "repo" | "machine" }
export interface QuicklyMatch extends QuicklyFile {
  name: string;
  parent: string;
  nameIndices: number[];
  parentIndices: number[];
}
export function markdownPath(file: string): boolean {
  return /\.(md|mdx|markdown|mdown|mkd)$/i.test(file) && !file.includes("\0");
}
export function mergeQuicklyFiles(groups: readonly (readonly QuicklyFile[])[], windows = false): QuicklyFile[] {
  const seen = new Set<string>();
  const merged: QuicklyFile[] = [];
  for (const group of groups) for (const file of group) {
    if (!markdownPath(file.path)) continue;
    const key = windows ? file.path.replaceAll("\\", "/").toLowerCase() : file.path;
    if (seen.has(key)) continue;
    seen.add(key); merged.push(file);
  }
  return merged;
}
export function quicklyCandidate(file: QuicklyFile, query: string, recentIndex = 0): RankedSearchResult<QuicklyFile> | null {
  const normalized = file.path.replaceAll("\\", "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const nameScore = scoreQueryMatch({ value: name, query, exactBase: 0, prefixBase: 100, boundaryBase: 200, includesBase: 300, fuzzyBase: 400 });
  const pathScore = nameScore === null ? scoreQueryMatch({ value: normalized.toLowerCase(), query, exactBase: 1000, prefixBase: 1100, boundaryBase: 1200, includesBase: 1300, fuzzyBase: 1400, boundaryMarkers: ["/", "-", "_", " "] }) : null;
  const score = query ? nameScore ?? pathScore : 0;
  if (score === null) return null;
  const boost = file.source === "tab" ? 80 : file.source === "recent" ? Math.max(1, 40 - recentIndex) : 0;
  // Preserve tab/recents order for an empty query; paths break all remaining ties.
  return { item: file, score: query ? score - boost : file.source === "tab" ? -20000 + recentIndex : file.source === "recent" ? -10000 + recentIndex : file.source === "machine" ? 10000 : 0,
    tieBreaker: String(file.path.length).padStart(8, "0") + file.path };
}
export function quicklyMatches(ranked: readonly RankedSearchResult<QuicklyFile>[], query: string): QuicklyMatch[] {
  return ranked.map(({ item }) => {
    const at = Math.max(item.path.lastIndexOf("/"), item.path.lastIndexOf("\\"));
    const name = item.path.slice(at + 1), parent = item.path.slice(0, at);
    const indices = findMatchIndices(item.path.replaceAll("\\", "/"), query);
    return { ...item, name, parent, nameIndices: findMatchIndices(name, query), parentIndices: indices.filter(i => i < at) };
  });
}
export function rankQuicklyFiles(files: readonly QuicklyFile[], rawQuery: string, limit = QUICKLY_LIMIT): QuicklyMatch[] {
  const query = normalizeSearchQuery(rawQuery).replaceAll("\\", "/");
  const ranked: RankedSearchResult<QuicklyFile>[] = [];
  for (let i = 0; i < files.length; i++) {
    const candidate = quicklyCandidate(files[i]!, query, i);
    if (candidate) insertRankedSearchResult(ranked, candidate, limit);
  }
  return quicklyMatches(ranked, query);
}

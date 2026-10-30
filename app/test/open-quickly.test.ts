import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mergeQuicklyFiles, rankQuicklyFiles, QUICKLY_CANDIDATE_LIMIT, type QuicklyFile, type QuicklyMatch } from "../src/shared/open-quickly";
import { indexedPaths, machineMarkdown, machinePathAllowed, QuicklySearch, repoMarkdown, spotlightArgs, walkMarkdown, type SearchSpawner } from "../src/main/open-quickly";
import { git } from "../src/main/git-runner";
import { configDefaults } from "../src/shared/config-schema";
import { parseConfig, serializeConfig } from "../src/shared/config";

const controller = () => new AbortController();
async function temporary(use: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "smd-quickly-")));
  try { await use(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("merges sources in order, deduplicates Windows paths, ranks names above paths and boosts tabs and recents", () => {
  const files: QuicklyFile[] = [
    { path: "/docs/guide/reference.md", source: "repo" }, { path: "/guide.md", source: "repo" },
    { path: "/tabs/guide.md", source: "tab" }, { path: "/recent/guide.md", source: "recent" },
  ];
  expect(rankQuicklyFiles(files, "guide").map(x => x.path)).toEqual(["/tabs/guide.md", "/recent/guide.md", "/guide.md", "/docs/guide/reference.md"]);
  const merged = mergeQuicklyFiles([[files[2]!], [files[2]!, files[0]!], [{ path: "/bad.txt", source: "repo" }]]);
  expect(merged.map(x => x.path)).toEqual(["/tabs/guide.md", "/docs/guide/reference.md"]);
  expect(mergeQuicklyFiles([[{ path: "C:\\Notes\\A.md", source: "tab" }, { path: "c:/notes/a.md", source: "recent" }]], true)).toHaveLength(1);
  expect(rankQuicklyFiles(files, "").map(x => x.source)).toEqual(["tab", "recent", "repo", "repo"]);
  expect(rankQuicklyFiles([{ path: "/longer/a.md", source: "repo" }, { path: "/a.md", source: "repo" }], "")[0]?.path).toBe("/a.md");
  expect(rankQuicklyFiles(Array.from({ length: 500 }, (_, i) => ({ path: `/docs/${i}.md`, source: "repo" })), "")).toHaveLength(200);
  expect(rankQuicklyFiles([{ path: "/my-guide/readme.mdx", source: "repo" }], "guide")[0]?.parentIndices).toEqual([4, 5, 6, 7, 8]);
});
test("config scope defaults, round trips and rejects unsupported scopes", () => {
  expect(configDefaults.openQuicklyScope).toBe("repo");
  expect(parseConfig(serializeConfig("# Keep\r\n", { openQuicklyScope: "everywhere" })).settings.openQuicklyScope).toBe("everywhere");
  expect(parseConfig("open-quickly-scope = network").issues).toHaveLength(1);
});
test("Git lists associated extensions, tracked and untracked files, honoring nested ignores", async () => temporary(async root => {
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  run("init", "-q");
  await mkdir(path.join(root, "nested/node_modules"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "node_modules/\nignored.md\n");
  for (const name of ["active.md", "new.mdx", "old.markdown", "a.mdown", "b.mkd", "UPPER.MD", "ignored.md", "other.txt", "nested/node_modules/no.md"]) await writeFile(path.join(root, name), "# Note");
  run("add", "active.md");
  const files = await repoMarkdown(path.join(root, "active.md"), controller().signal);
  expect(files.map(x => path.relative(root, x)).sort()).toEqual(["UPPER.MD", "a.mdown", "active.md", "b.mkd", "new.mdx", "old.markdown"]);
  expect((await git(["ls-files", "-z"], root)).trim()).toBe("active.md\0");
  await expect(git(["ls-files", "-z"], root, { maxBuffer: 2 })).rejects.toThrow();
  const cancelled = controller(); cancelled.abort();
  await expect(repoMarkdown(path.join(root, "active.md"), cancelled.signal)).rejects.toThrow();
}));
test("folder fallback bounds depth and entries and never follows symlinks or hidden/dependency directories", async () => temporary(async root => {
  await mkdir(path.join(root, "d/deep"), { recursive: true });
  await mkdir(path.join(root, ".hidden")); await mkdir(path.join(root, "node_modules"));
  for (const file of ["active.md", "d/ok.mdx", "d/deep/no.md", ".hidden/no.md", "node_modules/no.md"]) await writeFile(path.join(root, file), "# Note");
  await symlink(path.join(root, "d"), path.join(root, "link"), "dir");
  const files = await walkMarkdown(root, controller().signal, { depth: 1, entries: 20000 });
  expect(files.map(x => path.relative(root, x)).sort()).toEqual(["active.md", "d/ok.mdx"]);
  expect((await walkMarkdown(root, controller().signal, { depth: 6, entries: 1 })).length).toBeLessThanOrEqual(1);
  const fallback = await repoMarkdown(path.join(root, "active.md"), controller().signal);
  expect(fallback.map(x => path.relative(root, x)).sort()).toEqual(["active.md", "d/deep/no.md", "d/ok.mdx"]);
  const cancelled = controller(); cancelled.abort();
  await expect(walkMarkdown(root, cancelled.signal)).rejects.toThrow();
}));
function fakeSpawner(output: Buffer | Error, calls: { command: string; args: string[]; options: unknown; killed: boolean }[], delay = 0): SearchSpawner {
  return ((command: string, args: string[], options: unknown) => {
    const call = { command, args, options, killed: false }; calls.push(call);
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new PassThrough();
    child.kill = () => { call.killed = true; return true; };
    setTimeout(() => {
      if (call.killed) return;
      if (output instanceof Error) child.emit("error", output);
      else { child.stdout?.emit("data", output); if (call.killed) child.stdout?.emit("data", Buffer.from("/late.md\0")); child.emit("close", 0); }
    }, delay);
    return child;
  }) as SearchSpawner;
}
test("Spotlight uses fixed argument arrays, escaped literals, minimal env and filters unsafe locations", async () => {
  expect(spotlightArgs("a").at(-1)!).not.toContain('&&');
  const args = spotlightArgs('ab"*?\\');
  expect(args[0]).toBe("-0");
  expect(args.at(-1)!).toContain('net.daringfireball.markdown'); expect(args.at(-1)!).toContain('*.mdx');
  expect(args.at(-1)!).toContain('a*b*\\"*\\**\\?*\\\\');
  const calls: Parameters<typeof fakeSpawner>[1] = [];
  const spawner = fakeSpawner(Buffer.from(`/notes/yes.md\0${os.homedir()}/Library/no.md\0/Applications/A.app/no.md\0/tmp/cache/no.md\0/tmp/no.txt\0`), calls);
  expect(await machineMarkdown("ab", controller().signal, "darwin", spawner)).toEqual(["/notes/yes.md"]);
  expect(calls[0]).toMatchObject({ command: "/usr/bin/mdfind", args: spotlightArgs("ab"), options: { shell: false } });
  expect(Object.keys((calls[0]!.options as { env: object }).env).every(key => ["PATH", "HOME", "LANG", "SystemRoot"].includes(key))).toBe(true);
  expect(machinePathAllowed("relative.md")).toBe(false);
});
test("index streams cap results and bytes, and cancellation kills the process", async () => {
  const calls: Parameters<typeof fakeSpawner>[1] = [];
  expect(await indexedPaths("test", [], controller().signal, fakeSpawner(Buffer.from(Array.from({ length: QUICKLY_CANDIDATE_LIMIT + 1 }, (_, i) => `/notes/${i}.md\0`).join("")), calls))).toHaveLength(QUICKLY_CANDIDATE_LIMIT);
  expect(calls[0]?.killed).toBe(true);
  expect(await indexedPaths("test", [], controller().signal, fakeSpawner(Buffer.alloc(8 * 1024 * 1024 + 1), calls))).toEqual([]);
  const cancel = controller();
  const pending = indexedPaths("test", [], cancel.signal, fakeSpawner(Buffer.from("/note.md\0"), calls, 50));
  cancel.abort(); await expect(pending).rejects.toThrow("cancelled"); expect(calls.at(-1)?.killed).toBe(true);
});
test("Windows skips machine search and Linux tries locate only when plocate is unavailable", async () => {
  const calls: Parameters<typeof fakeSpawner>[1] = [];
  const unavailable = fakeSpawner(new Error("ENOENT"), calls);
  expect(await machineMarkdown("note", controller().signal, "win32", unavailable)).toEqual([]);
  expect(calls).toHaveLength(0);
  expect(await machineMarkdown("note", controller().signal, "linux", unavailable)).toEqual([]);
  expect(calls.map(x => x.command)).toEqual(["plocate", "locate"]);
  calls.length = 0;
  expect(await machineMarkdown("note", controller().signal, "linux", fakeSpawner(Buffer.from("/notes/note.mdx\0"), calls))).toEqual(["/notes/note.mdx"]);
  expect(calls).toHaveLength(1); expect(calls[0]?.args).toContain("--"); expect(calls[0]?.args).toContain("--regex"); expect(calls[0]?.args.at(-1)).toBe("[^/]*n[^/]*o[^/]*t[^/]*e[^/]*\\.(md|mdx|markdown|mdown|mkd)$");
});
test("closing or replacing a query cancels results; reopening refreshes the memory-only list", async () => temporary(async root => {
  const file = path.join(root, "active.md"); await writeFile(file, "# Note");
  const search = new QuicklySearch(file);
  const pending = search.search("", "repo", []); search.close(); expect(await pending).toEqual([]);
  expect(await search.search("", "repo", [])).toHaveLength(1);
  await writeFile(path.join(root, "new.mdx"), "# New");
  expect(await search.search("", "repo", [])).toHaveLength(1);
  const stale = search.search("active", "repo", []);
  const latest = search.search("nothing", "repo", []);
  expect(await stale).toEqual([]); expect(await latest).toEqual([]);
  search.close(); expect(await search.search("", "repo", [])).toHaveLength(2); search.close();
}));

test("100k candidate paths are ranked without truncating the input before matching", () => {
  const files: QuicklyFile[] = Array.from({ length: 100000 }, (_, i) => ({ path: `/repo/folder-${i}/note.md`, source: "repo" }));
  files.push({ path: "/repo/last/unique-needle.mdx", source: "repo" });
  expect(rankQuicklyFiles(files, "unique-needle").map(file => file.path)).toEqual(["/repo/last/unique-needle.mdx"]);
});

test("repo results publish before machine search completes and merged results deduplicate sources", async () => {
  let release: (files: string[]) => void = () => {};
  const machine = new Promise<string[]>(resolve => { release = resolve; });
  let published: (matches: QuicklyMatch[]) => void = () => {};
  const partial = new Promise<QuicklyMatch[]>(resolve => { published = resolve; });
  const search = new QuicklySearch(null, { repo: async () => ["/repo.md", "/open.md"], machine: async () => machine });
  let complete = false;
  const pending = search.search("", "everywhere", [{ path: "/open.md", source: "tab" }], published).then(matches => { complete = true; return matches; });
  expect((await partial).map(x => x.path)).toEqual(["/open.md", "/repo.md"]);
  expect(complete).toBe(false);
  release(["/open.md", "/repo.md", "/machine.mdx"]);
  expect((await pending).map(x => [x.path, x.source])).toEqual([["/open.md", "tab"], ["/repo.md", "repo"], ["/machine.mdx", "machine"]]);
  search.close();
});


test("repo queries ignore the absolute parent path for repo files, tabs and recents", async () => temporary(async root => {
  await mkdir(path.join(root, "docs"));
  const file = path.join(root, "docs/active.md"); await writeFile(file, "# Note");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const search = new QuicklySearch(file);
  const instant: QuicklyFile[] = [{ path: file, source: "tab" }];
  expect(await search.search(path.basename(root), "repo", instant)).toEqual([]);
  expect((await search.search("docs/active", "repo", instant)).map(file => file.path)).toEqual([file]);
  expect((await search.search("active", "repo", instant))[0]?.parent).toBe(path.join(root, "docs"));
  search.close();
}));

test("indexed candidates support noncontiguous filename queries before ranking", async () => {
  const calls: Parameters<typeof fakeSpawner>[1] = [];
  const candidates = await machineMarkdown("btrhlp", controller().signal, "darwin", fakeSpawner(Buffer.from("/notes/BetterHelp.mdx\0"), calls));
  expect(calls[0]?.args.at(-1)).toContain('"*b*t*r*h*l*p*"cd');
  expect(rankQuicklyFiles(candidates.map(path => ({ path, source: "machine" })), "btrhlp").map(file => file.name)).toEqual(["BetterHelp.mdx"]);
});

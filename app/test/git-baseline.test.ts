import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as runner from "../src/main/git-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readGitBaseline } from "../src/main/git-baseline";
setDefaultTimeout(60_000);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-git-")); dirs.push(dir); return dir; }
test("HEAD uses repository-relative literal paths, including spaces and shell characters", async () => {
  const dir = await directory();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("config", "core.autocrlf", "false");
  const file = path.join(dir, 'nested', 'a $(echo bad); plan.md');
  await fs.mkdir(path.dirname(file)); await fs.writeFile(file, "Committed\r\n");
  git("add", "--", file); git("commit", "-m", "fixture");
  await fs.writeFile(file, "Working tree");
  expect(await readGitBaseline(file)).toEqual({ available: true, text: "Committed\r\n" });
  const untracked = path.join(dir, "untracked.md"); await fs.writeFile(untracked, "New");
  expect((await readGitBaseline(untracked)).available).toBe(false);
});
test("outside a repository and unsaved files are unavailable", async () => {
  const file = path.join(await directory(), "note.md"); await fs.writeFile(file, "Hello");
  expect((await readGitBaseline(file)).available).toBe(false);
  expect((await readGitBaseline(null)).available).toBe(false);
});

test("Git ignores global configuration when reading HEAD", async () => {
  const { dir, git } = await repository();
  const file = path.join(dir, "note.md");
  await fs.writeFile(file, "Committed"); git("add", "."); git("commit", "-m", "fixture");
  const home = await directory();
  await fs.writeFile(path.join(home, ".gitconfig"), "[invalid global configuration\n");
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" });
    expect(await readGitBaseline(file)).toEqual({ available: true, text: "Committed" });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("missing git, timed-out reads, and oversized output disable HEAD", async () => {
  const dir = await directory(), file = path.join(dir, "note.md");
  await fs.writeFile(file, "Current");
  const root = await fs.realpath(dir);
  const run = spyOn(runner, "git");
  try {
    run.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await readGitBaseline(file)).toEqual({ available: false, reason: "Git is unavailable." });
    const success = async (args: string[]) => args.includes("rev-parse") ? root : args.includes("-s") ? "7" : "Fixture";
    run.mockImplementation(success);
    expect(await readGitBaseline(file)).toEqual({ available: true, text: "Fixture" });
    run.mockImplementation(async args => {
      if (args.includes("show")) throw Object.assign(new Error("too large"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      return success(args);
    });
    expect(await readGitBaseline(file)).toEqual({ available: false, reason: "The HEAD version exceeds the 25 MB Git read limit." });
    run.mockImplementation(async args => {
      if (args.includes("show")) throw Object.assign(new Error("timed out"), { killed: true });
      return success(args);
    });
    expect(await readGitBaseline(file)).toEqual({ available: false, reason: "Git did not respond within 2 seconds." });
  } finally { run.mockRestore(); }
});

async function repository() {
  const dir = await directory();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  return { dir, git };
}
test("partial clone cannot execute core.sshCommand to fetch a missing HEAD blob", async () => {
  const { dir, git } = await repository();
  const file = path.join(dir, "note.md"), marker = path.join(dir, "executed");
  await fs.writeFile(file, "Committed"); git("add", "."); git("commit", "-m", "fixture");
  const blob = git("rev-parse", "HEAD:note.md");
  await fs.unlink(path.join(dir, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  git("config", "extensions.partialClone", "origin"); git("config", "remote.origin.promisor", "true");
  git("config", "remote.origin.url", "ssh://invalid.example/repo");
  git("config", "core.sshCommand", `touch '${marker}'; false`);
  expect((await readGitBaseline(file)).available).toBe(false);
  expect(await fs.exists(marker)).toBe(false);
}, 60_000);
test("a bare repository embedded as ordinary tracked files is refused after clone", async () => {
  const { dir, git } = await repository();
  const trap = path.join(dir, "trap"); await fs.mkdir(trap);
  execFileSync("git", ["init", "--bare", trap], { stdio: "pipe" });
  const inner = (...args: string[]) => execFileSync("git", ["--git-dir", trap, "--work-tree", trap, ...args], { stdio: "pipe" });
  inner("config", "core.bare", "false"); inner("config", "core.worktree", ".");
  inner("config", "user.name", "Test"); inner("config", "user.email", "test@example.invalid");
  await fs.writeFile(path.join(trap, "note.md"), "Trap"); inner("add", "note.md"); inner("commit", "-m", "trap");
  git("add", "trap"); git("commit", "-m", "embedded repository");
  const cloned = path.join(await directory(), "clone"); execFileSync("git", ["clone", dir, cloned], { stdio: "pipe" });
  expect((await readGitBaseline(path.join(cloned, "trap/note.md"))).available).toBe(false);
}, 60_000);
test("Git receives a minimal environment and mandatory no-fetch hardening", async () => {
  const dir = await directory();
  const saved = { ...process.env };
  // Exercise the real runner, but finish at the process boundary. Startup latency
  // must not decide whether its arguments, environment and timeout are correct.
  const execute = spyOn(childProcess, "execFile").mockImplementation((...args) => {
    const callback = args[3];
    if (typeof callback !== "function") throw new Error("Expected an execFile callback");
    queueMicrotask(() => callback(null, "HEAD", ""));
    const child = new childProcess.ChildProcess();
    Object.defineProperty(child, "stdin", { value: null });
    return child;
  });
  try {
    Object.assign(process.env, { PATH: dir, GIT_DIR: "/trap", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "trap", GIT_EXEC_PATH: "/trap", GIT_CEILING_DIRECTORIES: "/", GIT_SSH: "/trap", NODE_OPTIONS: "--no-warnings" });
    expect(await runner.git(["show", "HEAD:note.md"], dir)).toBe("HEAD");
    const call = execute.mock.calls[0]!;
    expect(call[0]).toBe("git");
    expect(call[1]?.slice(0, 12)).toEqual(["--no-pager", "--no-lazy-fetch", "-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "core.attributesFile=/dev/null"]);
    const options = call[2];
    if (!options || typeof options !== "object") throw new Error("Expected execFile options");
    expect(options.timeout).toBe(2000);
    expect(options.maxBuffer).toBe(25 * 1024 * 1024);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(dir);
    expect(options.env?.GIT_NO_LAZY_FETCH).toBe("1");
    expect(options.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    for (const key of ["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_EXEC_PATH", "GIT_CEILING_DIRECTORIES", "GIT_SSH", "NODE_OPTIONS"]) expect(options.env?.[key]).toBeUndefined();
  } finally { execute.mockRestore(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test("ext transport cannot run its command while reading a missing object", async () => {
  const { dir, git } = await repository();
  const file = path.join(dir, "note.md"), marker = path.join(dir, "ext-executed");
  await fs.writeFile(file, "Committed"); git("add", "."); git("commit", "-m", "fixture");
  const blob = git("rev-parse", "HEAD:note.md");
  await fs.unlink(path.join(dir, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  git("config", "extensions.partialClone", "origin"); git("config", "remote.origin.promisor", "true");
  git("config", "remote.origin.url", `ext::sh -c touch% ${marker}`); git("config", "protocol.ext.allow", "always");
  expect((await readGitBaseline(file)).available).toBe(false);
  expect(await fs.exists(marker)).toBe(false);
}, 60_000);
test("older Git without no-lazy-fetch fails closed", async () => {
  const dir = await directory(), file = path.join(dir, "note.md"); await fs.writeFile(file, "Note");
  const run = spyOn(runner, "git").mockRejectedValue(new Error("unknown option: --no-lazy-fetch"));
  try {
    expect(await readGitBaseline(file)).toEqual({ available: false, reason: "This Git version cannot safely read HEAD. Update Git to use change highlights." });
    expect(run).toHaveBeenCalledTimes(1);
  } finally { run.mockRestore(); }
});

test("document mount never requests Git status and status inspection never invokes Git", async () => {
  const pane = await fs.readFile(path.resolve(import.meta.dir, "../src/renderer/pane.ts"), "utf8");
  expect(pane.includes("simplemd.gitStatus(")).toBe(false);
  const main = await fs.readFile(path.resolve(import.meta.dir, "../src/main/main.ts"), "utf8");
  expect(main.includes('handle("smd:git-status", id => ipcSession(id).gitStatus)')).toBe(true);
});

test("Git failures name untracked files, missing HEAD, repository absence and the size limit", async () => {
  const { dir, git } = await repository();
  const file = path.join(dir, "note.md"); await fs.writeFile(file, "Current");
  expect(await readGitBaseline(file)).toEqual({ available: false, reason: "This repository has no HEAD commit." });
  git("commit", "--allow-empty", "-m", "empty");
  expect(await readGitBaseline(file)).toEqual({ available: false, reason: "This file is untracked." });
  const outside = path.join(await directory(), "outside.md"); await fs.writeFile(outside, "Outside");
  expect(await readGitBaseline(outside)).toEqual({ available: false, reason: "This file is not in a Git repository." });
  await fs.writeFile(file, "x".repeat(25 * 1024 * 1024 + 1)); git("add", "note.md"); git("commit", "-m", "large");
  expect(await readGitBaseline(file)).toEqual({ available: false, reason: "The HEAD version exceeds the 25 MB Git read limit." });
}, 15_000);

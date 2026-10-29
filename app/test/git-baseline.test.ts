import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readGitBaseline } from "../src/main/git-baseline";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-git-")); dirs.push(dir); return dir; }
test("HEAD uses repository-relative literal paths, including spaces and shell characters", async () => {
  const dir = await directory();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
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

test.skipIf(process.platform === "win32")("missing git, timed-out reads, and oversized output disable HEAD", async () => {
  const dir = await directory(), file = path.join(dir, "note.md");
  await fs.writeFile(file, "Current");
  const previous = process.env.PATH;
  try {
    process.env.PATH = dir;
    expect(await readGitBaseline(file)).toEqual({ available: false, reason: "Git is unavailable." });
    const executable = path.join(dir, "git");
    const root = JSON.stringify(await fs.realpath(dir));
    const script = (body: string) => `#!${process.execPath}\nif (process.argv.includes('rev-parse')) process.stdout.write(${root}); else { ${body} }\n`;
    await fs.writeFile(executable, script("process.stdout.write('Fixture');"), { mode: 0o700 });
    expect(await readGitBaseline(file)).toEqual({ available: true, text: "Fixture" });
    await fs.writeFile(executable, script("process.stdout.write('x'.repeat(26 * 1024 * 1024));"), { mode: 0o700 });
    expect((await readGitBaseline(file)).available).toBe(false);
    await fs.writeFile(executable, script("setTimeout(() => process.stdout.write('Late'), 10000);"), { mode: 0o700 });
    const start = performance.now();
    expect((await readGitBaseline(file)).available).toBe(false);
    expect(performance.now() - start).toBeGreaterThan(1500);
    expect(performance.now() - start).toBeLessThan(5000);
  } finally { process.env.PATH = previous; }
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
});
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
});
test("Git receives a minimal environment and mandatory no-fetch hardening", async () => {
  const dir = await directory(), file = path.join(dir, "note.md"), output = path.join(dir, "call.json");
  await fs.writeFile(file, "Current");
  await fs.writeFile(path.join(dir, "git"), `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv.slice(2),env:process.env}));process.stdout.write(process.argv.includes('rev-parse') ? ${JSON.stringify(await fs.realpath(dir))} : 'HEAD');`, { mode: 0o700 });
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { PATH: dir, GIT_DIR: "/trap", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "trap", GIT_EXEC_PATH: "/trap", GIT_CEILING_DIRECTORIES: "/", GIT_SSH: "/trap", NODE_OPTIONS: "--no-warnings" });
    expect((await readGitBaseline(file)).available).toBe(true);
    const call = JSON.parse(await fs.readFile(output, "utf8"));
    expect(call.argv.slice(0, 12)).toEqual(["--no-pager", "--no-lazy-fetch", "-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "core.attributesFile=/dev/null"]);
    expect(call.env.GIT_NO_LAZY_FETCH).toBe("1");
    for (const key of ["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_EXEC_PATH", "GIT_CEILING_DIRECTORIES", "GIT_SSH", "NODE_OPTIONS"]) expect(call.env[key]).toBeUndefined();
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

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

test("missing git, timed-out reads, and oversized output disable HEAD", async () => {
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

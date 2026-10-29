import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type GitBaseline = { available: true; text: string } | { available: false; reason: string };
const MAX_GIT_BYTES = 25 * 1024 * 1024;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["--no-pager", ...args], {
      cwd, timeout: 2000, maxBuffer: MAX_GIT_BYTES, encoding: "utf8", shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end();
  });
}

export async function readGitBaseline(file: string | null): Promise<GitBaseline> {
  if (!file) return { available: false, reason: "Save the file in a Git repository first." };
  try {
    const canonical = await fs.realpath(file);
    let root: string;
    try { root = (await git(["rev-parse", "--show-toplevel"], path.dirname(canonical))).trimEnd(); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { available: false, reason: "Git is unavailable." };
      return { available: false, reason: "This file is outside a Git repository, or Git did not respond." };
    }
    const relative = path.relative(root, canonical);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { available: false, reason: "This file is outside the Git repository." };
    try { return { available: true, text: await git(["show", `HEAD:${relative.split(path.sep).join("/")}`], root) }; }
    catch { return { available: false, reason: "This file has no version in HEAD, or exceeds the Git read limit." }; }
  } catch { return { available: false, reason: "The file is unavailable." }; }
}

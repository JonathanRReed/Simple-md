import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type GitBaseline = { available: true; text: string } | { available: false; reason: string };
const MAX_GIT_BYTES = 25 * 1024 * 1024;

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (["PATH", "HOME", "LANG"].includes(key) || /^LC_[A-Z_]+$/.test(key)) env[key] = value;
  }
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
}
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["--no-pager", "--no-lazy-fetch", "-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "core.attributesFile=/dev/null", ...args], {
      cwd, timeout: 2000, maxBuffer: MAX_GIT_BYTES, encoding: "utf8", shell: false,
      env: gitEnvironment(),
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
      if (error instanceof Error && /unknown option.*no-lazy-fetch/.test(error.message)) return { available: false, reason: "This Git version cannot safely read HEAD. Update Git to use change highlights." };
      return { available: false, reason: "This file is outside a Git repository, or Git did not respond." };
    }
    const relative = path.relative(root, canonical);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { available: false, reason: "This file is outside the Git repository." };
    try { return { available: true, text: await git(["show", `HEAD:${relative.split(path.sep).join("/")}`], root) }; }
    catch { return { available: false, reason: "This file has no version in HEAD, or exceeds the Git read limit." }; }
  } catch { return { available: false, reason: "The file is unavailable." }; }
}

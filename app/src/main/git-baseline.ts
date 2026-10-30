import { perfMark } from "./perf.js";
import { git } from "./git-runner.js";
import fs from "node:fs/promises";
import path from "node:path";

perfMark("git-module-loaded");

export type GitBaseline = { available: true; text: string } | { available: false; reason: string };
const MAX_GIT_BYTES = 25 * 1024 * 1024;


export async function readGitBaseline(file: string | null): Promise<GitBaseline> {
  if (!file) return { available: false, reason: "Save the file in a Git repository first." };
  try {
    const canonical = await fs.realpath(file);
    let root: string;
    try { root = (await git(["rev-parse", "--show-toplevel"], path.dirname(canonical))).trimEnd(); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { available: false, reason: "Git is unavailable." };
      if (error instanceof Error && /unknown option.*no-lazy-fetch/.test(error.message)) return { available: false, reason: "This Git version cannot safely read HEAD. Update Git to use change highlights." };
      if (error instanceof Error && "killed" in error && error.killed) return { available: false, reason: "Git did not respond within 2 seconds." };
      return { available: false, reason: "This file is not in a Git repository." };
    }
    const relative = path.relative(root, canonical);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { available: false, reason: "This file is outside the Git repository." };
    try { await git(["rev-parse", "--verify", "HEAD"], root); }
    catch { return { available: false, reason: "This repository has no HEAD commit." }; }
    const literal = relative.split(path.sep).join("/");
    const object = `HEAD:${literal}`;
    let size: number;
    try { size = Number((await git(["cat-file", "-s", object], root)).trim()); }
    catch {
      try { await git(["--literal-pathspecs", "ls-files", "--error-unmatch", "--", literal], root); }
      catch { return { available: false, reason: "This file is untracked." }; }
      return { available: false, reason: "This file has no readable version in HEAD." };
    }
    if (!Number.isSafeInteger(size) || size < 0) return { available: false, reason: "Git returned an invalid object size." };
    if (size > MAX_GIT_BYTES) return { available: false, reason: "The HEAD version exceeds the 25 MB Git read limit." };
    try { return { available: true, text: await git(["show", object], root) }; }
    catch (error) {
      if (error instanceof Error && "killed" in error && error.killed) return { available: false, reason: "Git did not respond within 2 seconds." };
      if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { available: false, reason: "The HEAD version exceeds the 25 MB Git read limit." };
      return { available: false, reason: "Git could not read the HEAD version." };
    }
  } catch { return { available: false, reason: "The file is unavailable." }; }
}

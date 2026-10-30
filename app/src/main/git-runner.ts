import { execFile } from "node:child_process";

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (["PATH", "HOME", "LANG"].includes(key) || /^LC_[A-Z_]+$/.test(key)) env[key] = value;
  }
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
}
export function git(args: string[], cwd: string, options: { signal?: AbortSignal; timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["--no-pager", "--no-lazy-fetch", "-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "core.attributesFile=/dev/null", ...args], {
      cwd, timeout: options.timeout ?? 2000, maxBuffer: options.maxBuffer ?? 25 * 1024 * 1024, signal: options.signal, encoding: "utf8", shell: false,
      env: gitEnvironment(),
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end();
  });
}

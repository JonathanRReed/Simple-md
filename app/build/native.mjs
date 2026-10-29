import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = fileURLToPath(new URL("../", import.meta.url));

export function nativePlan(host, platform = process.platform, arch = process.arch) {
  const expected = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "win32-x64": "x86_64-pc-windows-msvc",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
  }[`${platform}-${arch}`];
  if (!expected || host !== expected) {
    throw new Error(`Rust host ${host} does not match ${platform}/${arch}. Use a matching native Rust and Bun toolchain. Cross-compilation and universal packages are not supported by this script.`);
  }
  const executable = platform === "win32" ? "simplemd-helper.exe" : "simplemd-helper";
  const targetDir = path.join(appDir, "native", "target");
  return {
    host,
    executable,
    cliExecutable: platform === "win32" ? "simplemd.exe" : "simplemd",
    cliBinary: path.join(targetDir, host, "release", platform === "win32" ? "simplemd.exe" : "simplemd"),
    cliDevelopmentBinary: path.join(targetDir, "release", platform === "win32" ? "simplemd.exe" : "simplemd"),
    args: ["build", "--locked", "--release", "--manifest-path", path.join(appDir, "native", "Cargo.toml"), "--target", host, "--target-dir", targetDir],
    binary: path.join(targetDir, host, "release", executable),
    developmentBinary: path.join(targetDir, "release", executable),
  };
}

export function run(command, args) {
  const result = spawnSync(command, args, { cwd: appDir, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with ${result.signal ?? result.status}`);
}

export function currentNativePlan() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  const host = result.stdout?.match(/^host: (\S+)$/m)?.[1];
  if (result.status !== 0 || !host) throw new Error("Could not read the Rust host. Install a native Rust toolchain first.");
  return nativePlan(host);
}

export function buildNative(plan) {
  run("cargo", plan.args);
  mkdirSync(path.dirname(plan.developmentBinary), { recursive: true });
  copyFileSync(plan.binary, plan.developmentBinary);
  copyFileSync(plan.cliBinary, plan.cliDevelopmentBinary);
}

if (import.meta.main) {
  const plan = currentNativePlan();
  if (process.argv.slice(2).includes("--dry-run")) console.log(JSON.stringify(plan, null, 2));
  else buildNative(plan);
}

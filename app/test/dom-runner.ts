import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";

export async function runDom(entrypoint: string, inputs: unknown, options: { media?: { name: string; value: string }[]; screenshot?: { path: string; width: number; height: number } } = {}): Promise<unknown> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "simplemd-dom-"));
  try {
    const bundle = path.join(temp, "browser.js");
    const built = await Bun.build({ entrypoints: [entrypoint], target: "browser", format: "iife" });
    if (!built.success || built.outputs.length !== 1) throw new Error(built.logs.join("\n"));
    await Bun.write(bundle, built.outputs[0]!);
    const input = path.join(temp, "input.json");
    const output = path.join(temp, "output.json");
    await Bun.write(input, JSON.stringify(inputs));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    env.SMD_DOM_OPTIONS = JSON.stringify(options);
    // Hosted Linux runners lack a configured SUID sandbox helper; the DOM harness only loads local fixtures.
    const sandbox = process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [];
    const child = Bun.spawn([String(electron), ...sandbox, `--user-data-dir=${path.join(temp, "profile")}`, path.join(import.meta.dir, "corpus/dom-driver.cjs"), input, bundle, output], {
      env, stdout: "ignore", stderr: "pipe", signal: AbortSignal.timeout(60_000),
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`DOM process exited ${code}: ${stderr}`);
    return await Bun.file(output).json();
  } finally { await rm(temp, { recursive: true, force: true }); }
}

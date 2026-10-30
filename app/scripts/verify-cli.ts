import { buildTestCli } from "../build/native.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { DriverStep } from "../src/main/driver";
import { cliRuntime } from "../src/main/cli-runtime";
import { frame } from "../src/main/cli-protocol";

const appRoot = path.resolve(import.meta.dir, "..");
const cli = buildTestCli();
const electron = path.join(appRoot, "node_modules/electron/dist", fs.readFileSync(path.join(appRoot, "node_modules/electron/path.txt"), "utf8").trim());
const devLaunch = { SMD_CLI_APP: electron, SMD_CLI_APP_ROOT: appRoot };
const filter = process.argv[2];
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smd-cli-smoke-")));
const bin = path.join(root, "bin"); fs.mkdirSync(bin); fs.symlinkSync(cli, path.join(bin, process.platform === "win32" ? "simplemd.exe" : "simplemd"));
const first = path.join(root, "seed.md"); fs.writeFileSync(first, "# Seed\n\nKeep this document.\n");
const text = "# Same\n\nParagraph.\n\n# Same\n\nLine seven.\n";
const file = path.join(root, "note.md"); fs.writeFileSync(file, text);
const commitFile = path.join(root, "COMMIT_EDITMSG"); fs.writeFileSync(commitFile, "test commit\n");
const results: string[] = [];
const processes: ChildProcess[] = [];
const runtimes = new Set<string>();
const evalStep = (code: string): DriverStep => ({ eval: `(async () => {
  const assert = (v, m) => { if (!v) throw new Error(m); };
  const waitFor = async (fn) => { const end = performance.now() + 15000; while (!fn()) { if (performance.now() > end) throw new Error('CLI UI assertion timed out'); await new Promise(r => setTimeout(r, 10)); } };
  ${code}
})()` });
const painted = (file: string) => evalStep(`await waitFor(() => document.documentElement.dataset.documentPath === ${JSON.stringify(file)} && document.documentElement.dataset.documentPainted === ${JSON.stringify(file)});`);
async function until(predicate: () => boolean, timeout = 20000) {
  const end = performance.now() + timeout;
  while (!predicate()) { if (performance.now() > end) throw new Error("CLI smoke timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function run(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string | Buffer) {
  const child = spawn(command, args, { cwd: appRoot, env, stdio: ["pipe", "pipe", "pipe"] }); processes.push(child);
  let errors = "", output = ""; child.stderr!.on("data", data => errors += String(data)); child.stdout!.on("data", data => output += String(data));
  const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (input !== undefined) child.stdin!.end(input);
  return { child, done, errors: () => errors, output: () => output };
}
async function session(name: string, steps: DriverStep[], actions: Record<string, (env: NodeJS.ProcessEnv) => Promise<void>>, settings: object = {}) {
  if (filter && !name.includes(filter)) return;
  const profile = path.join(root, name); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ mode: "source", autosave: false, launchAtLogin: false, ...settings }));
  const drive = path.join(profile, "drive.json"); fs.writeFileSync(drive, JSON.stringify(steps));
  const runtime = cliRuntime(profile); runtimes.add(runtime);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, SMD_USER_DATA: profile, SMD_CLI_RUNTIME: runtime, SMD_DRIVE: drive, SMD_TRACE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = run(electron, [appRoot, first], env);
  let pending = ""; let tasks = Promise.resolve(); let actionError: unknown;
  app.child.stdout!.on("data", chunk => {
    pending += String(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.startsWith("smd-perf ")) continue;
      const data = JSON.parse(line.slice(9));
      if (data.kind !== "barrier") continue;
      tasks = tasks.then(async () => {
        const action = actions[data.name]; assert(action, `Unknown CLI smoke barrier ${data.name}`);
        await action(env); app.child.stdin!.write(data.name + "\n");
      }).catch(error => { actionError = error; app.child.kill("SIGKILL"); });
    }
  });
  const timer = setTimeout(() => app.child.kill("SIGKILL"), 90000);
  try {
    const code = await app.done; await tasks;
    fs.writeFileSync(path.join(profile, "electron.log"), app.output() + app.errors());
    if (actionError) throw actionError;
    assert.equal(code, 0, `${name}: ${app.errors()}`);
    results.push(name);
  } finally { clearTimeout(timer); }
}
async function ok(env: NodeJS.ProcessEnv, args: string[], input?: string | Buffer) {
  const invocation = run(cli, args, env, input); assert.equal(await invocation.done, 0, invocation.errors());
}
try {
  let waiter: ReturnType<typeof run>; let second: ReturnType<typeof run>;
  await session("open-navigation-wait", [
    { barrier: "open" }, painted(file),
    evalStep(`await waitFor(() => document.querySelector('.document-pane[data-active="true"]')?.dataset.view === 'read');`),
    { barrier: "line" }, evalStep(`await waitFor(() => document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent === 'Line seven.');`),
    { barrier: "heading" }, evalStep(`await waitFor(() => document.querySelector('.document-pane[data-active="true"]')?.dataset.view === 'read' && document.querySelector('#doc #user-content-same-1')); assert(document.querySelector('#doc #user-content-same-1').textContent === 'Same', 'Duplicate heading slug did not open Read');`),
    { barrier: "wait" }, { save: true }, { barrier: "saved" },
    evalStep(`await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId));`),
    { barrier: "closed" },
  ], {
    open: env => ok(env, [file]), line: env => ok(env, [file + ":7"]), heading: env => ok(env, [file + "#same-1"]),
    wait: async env => { waiter = run(cli, ["--wait", file], env); second = run(cli, ["--wait", file], env); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(waiter.child.exitCode, null); },
    saved: async () => { assert.equal(waiter.child.exitCode, null); assert.equal(second.child.exitCode, null); },
    closed: async () => { assert.equal(await waiter.done, 0, waiter.errors()); assert.equal(await second.done, 0, second.errors()); },
  });
  // ux-app: reading defaults, Source editor jobs and specific CLI failures.
  const missing = path.join(root, "missing.md"), binary = path.join(root, "binary.md"), denied = path.join(root, "denied.md");
  fs.writeFileSync(binary, Buffer.from([0, 255])); fs.writeFileSync(denied, "Private");
  if (process.platform !== "win32") fs.chmodSync(denied, 0);
  await session("ux-open-policy-errors", [
    { barrier: "normal" }, painted(file),
    evalStep(`await waitFor(() => document.querySelector('.document-pane[data-active="true"]')?.dataset.view === 'read');`),
    { barrier: "line" },
    evalStep(`await waitFor(() => document.querySelector('.document-pane[data-active="true"] [data-element="edit"]')?.dataset.mode === 'source' && document.querySelector('.document-pane[data-active="true"]')?.dataset.view === 'edit');`),
    { barrier: "commit" }, painted(commitFile),
    evalStep(`assert(document.querySelector('.document-pane[data-active="true"]').dataset.view === 'edit', 'Extensionless editor job opened Read'); assert(document.querySelector('.document-pane[data-active="true"] [data-element="edit"]').dataset.mode === 'source', 'Commit message did not use Source');`),
    { barrier: "errors" },
  ], {
    normal: env => ok(env, [file]), line: env => ok(env, [file + ":7"]), commit: env => ok(env, [commitFile]),
    errors: async env => {
      const cases: [string, string][] = [[missing, "File does not exist"], [root, "Cannot open a directory"], [binary, "Binary or invalid UTF-8"], [file + "#not-a-heading", "Heading not found: #not-a-heading"]];
      if (process.platform !== "win32") cases.push([denied, "Permission denied"]);
      for (const [arg, message] of cases) { const invocation = run(cli, [arg], env); assert.equal(await invocation.done, 1, invocation.errors()); assert(invocation.errors().includes(message), invocation.errors()); }
    },
  }, { mode: "live" });
  if (process.platform !== "win32") fs.chmodSync(denied, 0o600);
  const capacityWaiters: ReturnType<typeof run>[] = [];
  await session("waiter-capacity", [
    { barrier: "waiters" }, painted(file),
    evalStep(`await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId));`),
    { barrier: "waiters-closed" },
  ], {
    waiters: async env => {
      for (let i = 0; i < 20; i++) { capacityWaiters.push(run(cli, ["--wait", file], env)); await new Promise(resolve => setTimeout(resolve, 80)); }
      await new Promise(resolve => setTimeout(resolve, 500));
      for (const waiter of capacityWaiters) assert.equal(waiter.child.exitCode, null);
      await ok(env, [file]);
    },
    "waiters-closed": async () => { for (const waiter of capacityWaiters) assert.equal(await waiter.done, 0, waiter.errors()); },
  });
  const stdinText = "# Stdin\n\n<Widget />\n\n![local](./secret.png)\n";
  const savedStdin = path.join(root, "stdin-saved.md");
  await session("stdin-save-as-wait", [
    { barrier: "stdin" }, evalStep(`await waitFor(() => document.querySelector('.document-pane[data-active="true"] [data-element="name"]')?.textContent === 'pipe.mdx'); assert(document.querySelector('.document-pane[data-active="true"] [data-element="edit"]').dataset.mode === 'source', '--wait stdin did not use Source'); assert(!document.documentElement.dataset.documentPath, 'Stdin acquired a disk path');`),
    evalStep(`window.simplemd.command('mode-split'); await waitFor(() => document.querySelector('#preview .mdx-component')); assert(![...document.querySelectorAll('#preview img')].some(image => /^file:/i.test(image.getAttribute('src') || '')), 'Piped image acquired a local path');`),
    { savePath: savedStdin },
    { save: true }, evalStep(`await waitFor(() => document.querySelector('.document-pane[data-active="true"] [data-element="name"]')?.textContent === 'stdin-saved.md');`),
    { barrier: "save-as" },
    evalStep(`await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId));`),
    { barrier: "stdin-closed" },
  ], {
    stdin: async env => { waiter = run(cli, ["--wait", "--stdin-name", "pipe.mdx", "-"], env, stdinText); await new Promise(resolve => setTimeout(resolve, 200)); },
    "save-as": async () => { assert.equal(waiter.child.exitCode, null); assert.equal(fs.readFileSync(savedStdin, "utf8"), stdinText); },
    "stdin-closed": async () => { assert.equal(await waiter.done, 0, waiter.errors()); },
  });
  await session("cancel-and-discard", [
    { barrier: "dirty" }, evalStep(`await waitFor(() => document.querySelector('.document-pane[data-active="true"] [data-element="name"]')?.textContent === 'discard.md');`),
    { dialog: { response: 2 } }, evalStep(`assert(!(await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId))), 'Cancelled close succeeded');`),
    { barrier: "cancelled" }, { dialog: { response: 1 } }, evalStep(`assert(await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId)), 'Confirmed discard failed');`),
    { barrier: "discarded" },
  ], {
    dirty: async env => { waiter = run(cli, ["--wait", "--stdin-name", "discard.md", "-"], env, "# Discard me\n"); await new Promise(resolve => setTimeout(resolve, 150)); },
    cancelled: async () => { assert.equal(waiter.child.exitCode, null); },
    discarded: async () => { assert.equal(await waiter.done, 0, waiter.errors()); },
  });
  const html = path.join(root, "out.html"), pdf = path.join(root, "out.pdf");
  await session("exports-url-secret", [
    { barrier: "export" }, painted(first), { windowCount: 1 },
    { barrier: "url" }, painted(file),
    { barrier: "invalid-url" }, painted(file),
  ], {
    export: async env => {
      await ok(env, ["export", file, "--format", "html", "-o", html]);
      await ok(env, ["export", file, "--format", "pdf", "-o", pdf]);
      assert(fs.readFileSync(html, "utf8").includes('>Same</h1>'));
      assert(fs.readFileSync(pdf).subarray(0, 5).equals(Buffer.from("%PDF-")));
      const duplicate = run(cli, ["export", file, "--format", "html", "-o", html], env); assert.equal(await duplicate.done, 1);
      if (process.platform !== "win32") fs.chmodSync(html, 0o640);
      await ok(env, ["export", file, "--format", "html", "-o", html, "--force"]);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(html).mode & 0o777, 0o640);
        assert.equal(fs.statSync(pdf).mode & 0o777, 0o666 & ~process.umask());
      }
      const wrong = net.createConnection(path.join(env.SMD_CLI_RUNTIME!, "ipc.sock"));
      await new Promise<void>(resolve => wrong.once("connect", resolve));
      const closed = new Promise<void>(resolve => wrong.once("close", resolve));
      wrong.write(frame(Buffer.from(JSON.stringify({ version: 1, id: "wrong", secret: "0".repeat(64), command: "open", path: file, wait: false })))); await closed;
    },
    url: async env => { const app = run(electron, [appRoot, "--", `simplemd://open?path=${encodeURIComponent(file)}&line=7`], env); assert.equal(await app.done, 0, app.errors()); },
    "invalid-url": async env => {
      const urls = [`simplemd://export?path=${encodeURIComponent(first)}`, `simplemd://open?path=${encodeURIComponent(path.join(root, "secret.txt"))}`];
      if (process.platform === "win32") for (const file of [String.raw`\\attacker\share\note.md`, "//attacker/share/note.md", String.raw`\\?\C:\note.md`, String.raw`\\.\C:\note.md`]) urls.push(`simplemd://open?path=${encodeURIComponent(file)}`);
      for (const url of urls) { const app = run(electron, [appRoot, "--", url], env); assert.equal(await app.done, 0, app.errors()); }
    },
  });
  const repo = path.join(root, "git"); fs.mkdirSync(repo);
  for (const args of [["init"], ["config", "user.name", "CLI Smoke"], ["config", "user.email", "cli@example.test"]]) assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "file"), "content\n"); assert.equal(spawnSync("git", ["add", "file"], { cwd: repo }).status, 0);
  let git: ReturnType<typeof run>;
  await session("git-editor", [
    { barrier: "git" }, painted(path.join(repo, ".git/COMMIT_EDITMSG")),
    evalStep(`await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId));`),
    { barrier: "git-finished" },
  ], {
    git: async env => {
      // Git must invoke the PATH-resolved CLI through its normal editor contract.
      git = run("git", ["-C", repo, "commit", "--allow-empty", "--edit", "-m", "CLI editor commit"], { ...env, GIT_EDITOR: "simplemd --wait" });
    },
    "git-finished": async () => { assert.equal(await git.done, 0, git.errors()); assert.equal(spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim(), "CLI editor commit"); },
  });
  // The CLI starts Electron itself, then retries its private socket.
  if (!filter || "cold-open".includes(filter)) {
    const profile = path.join(root, "cold"); fs.mkdirSync(profile);
    const runtime = cliRuntime(profile); runtimes.add(runtime);
    fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ launchAtLogin: false, autosave: false }));
    const shot = path.join(root, "cold.png"), drive = path.join(root, "cold-drive.json");
    fs.writeFileSync(drive, JSON.stringify([painted(file), { shot }, { wait: 150 }]));
    const env: NodeJS.ProcessEnv = { ...process.env, ...devLaunch, SMD_USER_DATA: profile, SMD_CLI_RUNTIME: runtime, SMD_DRIVE: drive };
    delete env.ELECTRON_RUN_AS_NODE;
    await ok(env, [file]); await until(() => fs.existsSync(shot)); await until(() => !fs.existsSync(path.join(runtime, "state.json")));
    results.push("cold-open");
  }
  assert(results.length, `No CLI smoke cases match ${JSON.stringify(filter)}.`);
  fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify({ results, cli, devLaunch, root }, null, 2));
  console.log(JSON.stringify({ status: "pass", results, receipt: path.join(root, "receipt.json") }, null, 2));
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill("SIGKILL");
  for (const runtime of runtimes) {
    const state = path.join(runtime, "state.json");
    if (fs.existsSync(state)) { const value = JSON.parse(fs.readFileSync(state, "utf8")); try { process.kill(value.pid, "SIGKILL"); } catch { /* already exited */ } }
    for (const name of ["state.json", "ipc.sock"]) fs.rmSync(path.join(runtime, name), { force: true });
    try { fs.rmdirSync(runtime); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) console.warn(`could not remove ${runtime}`, error); }
  }
}

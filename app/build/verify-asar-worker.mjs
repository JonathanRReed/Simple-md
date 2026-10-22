import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { appDir } from "./native.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const archive = path.resolve(process.argv[2] ?? "");
assert(process.argv[2] && path.basename(archive) === "app.asar" && fs.statSync(archive).isFile(),
  "Usage: bun build/verify-asar-worker.mjs /absolute/path/to/app.asar [electron-executable]");
const electronDir = path.dirname(require.resolve("electron/package.json"));
const electron = process.argv[3] ? path.resolve(process.argv[3]) : path.join(electronDir, "dist", fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim());
assert(fs.existsSync(electron), "Electron is missing. Install project dependencies before running this smoke.");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const beforeHash = hash(fs.readFileSync(archive));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-md-asar-worker-"));
const entries = ["dist/main.mjs", "dist/main-app.mjs", "dist/render-worker.mjs"];
const inputs = entries.map((name) => {
  const bytes = asar.extractFile(archive, name);
  assert(!asar.statFile(archive, name).unpacked, `${name} must remain packed for this smoke`);
  const local = path.join(appDir, name);
  return { name, bytes: bytes.length, sha256: hash(bytes), matchesDist: fs.existsSync(local) && bytes.equals(fs.readFileSync(local)) };
});
assert(inputs.every((input) => input.matchesDist), "ASAR bootstrap, main, or worker differs from current dist. Package the current build first.");
const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
assert.equal(packaged.main, "dist/main.mjs");
const chunks = asar.listPackage(archive).filter((name) => name.startsWith("/dist/chunks/") && name.endsWith(".mjs"));
assert(chunks.length > 0, "ASAR has no shared or lazy chunks");
assert(chunks.every((name) => !asar.statFile(archive, name.slice(1)).unpacked), "Shared and lazy chunks must remain packed for this smoke");
const chunksMatchDist = chunks.every((name) => {
  const relative = name.slice(1);
  const local = path.join(appDir, relative);
  return fs.existsSync(local) && asar.extractFile(archive, relative).equals(fs.readFileSync(local));
});
assert(chunksMatchDist, "ASAR shared or lazy chunks differ from current dist");
const resultFile = path.join(root, "runtime.json");
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "simple-md-asar-worker-smoke", version: "1.0.0", main: "main.cjs" }));
fs.writeFileSync(path.join(root, "main.cjs"), `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { app } = require('electron');
assert(process.versions.electron && app, 'This smoke must run under Electron, not Node mode');
app.setPath('userData', path.join(__dirname, 'profile'));
app.setPath('sessionData', path.join(__dirname, 'session'));
app.disableHardwareAcceleration();
let worker;
let completed = false;
const details = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, archive: ${JSON.stringify(archive)} };
const timeout = setTimeout(() => finish(new Error('ASAR worker smoke timed out')), 20000);
function finish(error) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ ...details, status: error ? 'Failed' : 'Verified', error: error?.stack }, null, 2));
  if (error) console.error(error);
  Promise.resolve(worker?.terminate()).then(() => app.exit(error ? 1 : 0), () => app.exit(1));
}
app.whenReady().then(() => {
  const workerUrl = pathToFileURL(path.join(${JSON.stringify(archive)}, 'dist', 'render-worker.mjs'));
  details.workerUrl = workerUrl.href;
  worker = new Worker(workerUrl);
  worker.on('error', finish);
  worker.on('exit', code => { if (!completed) finish(new Error('Worker exited unexpectedly: ' + code)); });
  worker.on('message', response => {
    try {
      if (response.kind === 'error') throw new Error(response.message);
      if (response.id === 1) {
        assert.equal(response.kind, 'warmup');
        worker.postMessage({ id: 2, kind: 'blocks', text: '# ASAR worker smoke\\n\\n' + '\x60\x60\x60ts\\nconst answer: number = 42;\\n\x60\x60\x60\\n', filePath: '/tmp/asar-worker-smoke.md' });
      } else if (response.id === 2) {
        assert.equal(response.kind, 'blocks');
        assert.equal(response.value.title, 'asar-worker-smoke');
        const html = response.value.blocks.map(block => block.html).join('');
        assert.match(html, /ASAR worker smoke/);
        assert.match(html, /shiki/);
        assert.match(html, /<span[^>]*style=/);
        assert.match(html, /answer/);
        fs.writeFileSync(path.join(__dirname, 'blocks.html'), html);
        details.blocks = response.value.blocks.length;
        worker.postMessage({ id: 3, kind: 'fragment', text: '\x60\x60\x60python\\nprint("asar lazy grammar")\\n\x60\x60\x60\\n' });
      } else if (response.id === 3) {
        assert.equal(response.kind, 'fragment');
        assert.match(response.value, /shiki/);
        assert.match(response.value, /<span[^>]*style=/);
        assert.match(response.value, /asar lazy grammar/);
        fs.writeFileSync(path.join(__dirname, 'fragment.html'), response.value);
        details.highlightedLanguages = ['typescript', 'python'];
        finish();
      } else throw new Error('Unexpected worker response ID');
    } catch (error) { finish(error); }
  });
  worker.postMessage({ id: 1, kind: 'warmup' });
}).catch(finish);
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const result = spawnSync(electron, [root], { env, encoding: "utf8", timeout: 35000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
fs.writeFileSync(path.join(root, "electron.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
const receipt = {
  archive, archiveSha256: beforeHash, archiveUnchanged: hash(fs.readFileSync(archive)) === beforeHash,
  inputs, chunks: chunks.length, chunksMatchDist, electron, exitCode: result.status, signal: result.signal,
  spawnError: result.error?.message, runtime: fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null,
};
fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ evidence: root, ...receipt }, null, 2));
assert.equal(result.status, 0, `Electron failed. Inspect ${root}/electron.log`);
assert.equal(receipt.runtime?.status, "Verified");
assert(receipt.archiveUnchanged, "Archive changed while the smoke was running");

import { waitForGuiLoad } from "./host-load";
import { typingProbe, typingInput, typingLetters, typingRecord, calibratedTyping } from "./perf-typing";
import { summarizeEventTiming } from "./perf-gate";
import { assertDocument as assertPerfDocument } from "./perf-gate";
import assert from "node:assert/strict";
import type { KeyboardInputEvent } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliRuntime } from "../src/main/cli-runtime";
import { configEntries } from "../src/shared/config-schema";
import type { DriverStep } from "../src/main/driver";

type Step = DriverStep;
type Result = { name: string; status: "passed" } | { name: string; status: "failed"; error: string };
type DiskChange = { marker: string; file: string; text: string; preserveTimes?: boolean };

const appRoot = path.resolve(import.meta.dir, "..");
const dist = path.join(appRoot, "dist");
const executable = path.join(appRoot, "node_modules/electron/dist", fs.readFileSync(path.join(appRoot, "node_modules/electron/path.txt"), "utf8").trim());
const bundled = fs.readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".mjs"));
assert(bundled.some((file) => fs.readFileSync(path.join(dist, file), "utf8").includes("SMD_USER_DATA")), "Build the app with the isolated SMD_USER_DATA contract before running smoke tests.");
assert(fs.existsSync(executable), "Local Electron executable is missing.");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-md-smoke-"));
const results: Result[] = [];
const filter = process.argv[2];
const quote = JSON.stringify;
const mod = process.platform === "darwin" ? "meta" : "control";

function evaluate(code: string): Step {
  return { eval: `(async () => {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const waitFor = async (predicate, message, timeoutMs = 10000) => {
      const deadline = performance.now() + timeoutMs;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const editorText = () => [...document.querySelectorAll('.cm-content .cm-line')].map(line => line.textContent).join('\\n');
    ${code}
  })()` };
}

function appendCharacter(char: string): Step[] {
  return [
    evaluate("await waitFor(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true', 'Editor stayed frozen.'); document.querySelector('.cm-content').focus();"),
    { input: { type: "keyDown", keyCode: "A", modifiers: [mod] } },
    { input: { type: "keyUp", keyCode: "A", modifiers: [mod] } },
    { input: { type: "keyDown", keyCode: "Right" } },
    { input: { type: "keyUp", keyCode: "Right" } },
    { input: { type: "char", keyCode: char } },
    evaluate(`await waitFor(() => editorText().endsWith(${quote(char)}), 'Typed character did not reach CodeMirror.');
      await waitFor(() => !document.querySelector('#dirty').hidden, 'Typing did not mark the note dirty.');`),
  ];
}

function fixture(name: string, text: string): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

async function launch(name: string, file: string, steps: Step[], intent: "read" | "edit" | "default" = "read", change?: DiskChange, expectedExit: 0 | 1 = 0, initialMode: "source" | "split" | "live" = "source", options: { env?: NodeJS.ProcessEnv; prepare?: (profile: string) => void } = {}): Promise<void> {
  await waitForGuiLoad();
  const output = path.join(root, name);
  const profile = path.join(output, "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
    mode: initialMode, autosave: false, launchAtLogin: false,
  }));
  options.prepare?.(profile);
  const done = path.join(output, "done.png");
  const drive = path.join(output, "drive.json");
  const last = steps.at(-1);
  const sequence = last && "menuQuit" in last ? [...steps.slice(0, -1), { shot: done }, last] : [...steps, { shot: done }];
  fs.writeFileSync(drive, JSON.stringify(sequence, null, 2));
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, SMD_USER_DATA: profile, SMD_DRIVE: drive, SMD_INTENT: intent === "default" ? undefined : intent, SMD_TRACE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let logs = "";
  let injected = false;
  let mutationError: unknown;
  const poll = change && setInterval(() => {
    if (!fs.existsSync(change.marker)) return;
    clearInterval(poll);
    try {
      const temporary = `${change.file}.external`;
      const stat = fs.statSync(change.file);
      fs.writeFileSync(temporary, change.text);
      if (change.preserveTimes) fs.utimesSync(temporary, stat.atime, stat.mtime);
      fs.renameSync(temporary, change.file);
      if (change.preserveTimes) {
        const replaced = fs.statSync(change.file);
        assert.equal(replaced.mtimeMs, stat.mtimeMs, "Cache fixture did not preserve mtime.");
        assert.equal(replaced.size, stat.size, "Cache fixture did not preserve size.");
      }
      injected = true;
    } catch (error) {
      mutationError = error;
    }
  }, 20);
  try {
    const child = spawn(executable, [appRoot, file], { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (data: Buffer) => { logs = (logs + String(data)).slice(-1_000_000); });
    child.stderr.on("data", (data: Buffer) => { logs = (logs + String(data)).slice(-1_000_000); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
    const forceTimeout = setTimeout(() => child.kill("SIGKILL"), 93_000);
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      clearTimeout(timeout);
      clearTimeout(forceTimeout);
      fs.writeFileSync(path.join(output, "electron.log"), logs);
    }
    fs.writeFileSync(path.join(output, "exit.json"), JSON.stringify({ ...exit, expectedExit }, null, 2));
    assert.equal(exit.code, expectedExit, `Electron exited with code ${exit.code}, signal ${exit.signal}; expected ${expectedExit}.\n${logs}`);
    if (expectedExit !== 0) {
      assert(!fs.existsSync(done), "Driver continued after the deliberate assertion failure.");
      assert(logs.includes("SMOKE_EXPECTED_DRIVER_FAILURE"), "Electron failed for an unrelated reason.");
      return;
    }
    assert(fs.existsSync(done), `Driver did not finish all assertions.\n${logs}`);
    assert(fs.statSync(done).size > 100, "Completion screenshot is empty.");
    if (mutationError) throw mutationError;
    if (change) assert(injected, "External-change fixture was not written.");
  } finally {
    if (poll) clearInterval(poll);
    const runtime = cliRuntime(profile);
    for (const name of ["state.json", "ipc.sock"]) fs.rmSync(path.join(runtime, name), { force: true });
    try { fs.rmdirSync(runtime); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) console.warn(`could not remove ${runtime}`, error); }
  }
}

async function test(name: string, run: () => Promise<void>): Promise<void> {
  if (filter && !name.includes(filter)) return;
  try {
    await run();
    results.push({ name, status: "passed" });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "failed", error: message });
    console.error(`FAIL ${name}\n${message}`);
  }
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const note = "# Smoke edit note\n\nOriginal text.\n";

if (process.platform !== "win32") await test("m6-security-git-is-lazy", async () => {
  const file = fixture("m6-security-git-lazy/note.md", note);
  const marker = path.join(root, "git-invoked");
  const bin = path.join(root, "git-probe-bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${quote(marker)}, 'invoked'); process.exit(1);`, { mode: 0o700 });
  const options = { env: { PATH: bin + path.delimiter + process.env.PATH } };
  await launch("m6-security-git-mount", file, [
    { nativeMenuState: { path: ["View", "Show Changes Since Last Commit"], enabled: true, checked: false } },
  ], "read", undefined, 0, "source", options);
  assert(!fs.existsSync(marker), "Mount or menu inspection invoked Git.");
  await launch("m6-security-git-explicit", file, [
    { nativeMenu: ["View", "Show Changes Since Last Commit"] },
    evaluate(`const id = Number(document.querySelector('.document-pane').dataset.documentId); for (let i = 0; (await window.simplemd.gitStatus(id)).available; i++) { assert(i < 200, 'Explicit Git failure was not reported.'); await new Promise(resolve => setTimeout(resolve, 25)); }`),
  ], "read", undefined, 0, "source", options);
  assert(fs.existsSync(marker), "Explicit Git action did not invoke Git.");
});

if (process.platform !== "win32") await test("m6-security-cli-unavailable", async () => {
  const file = fixture("m6-security-cli-unavailable/note.md", note);
  await launch("m6-security-cli-unavailable", file, [
    evaluate(`assert(document.querySelector('#doc h1')?.textContent === 'Smoke edit note', 'CLI failure blocked the document.');`),
  ], "read", undefined, 0, "source", { prepare(profile) { fs.mkdirSync(cliRuntime(profile), { mode: 0o755 }); } });
  assert(fs.readFileSync(path.join(root, "m6-security-cli-unavailable/electron.log"), "utf8").includes("CLI unavailable"));
});

await test("m6-security-change-size", async () => {
  const file = fixture("m6-security-change-size/note.md", "# Large\n\n" + "x".repeat(2 * 1024 * 1024));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path.dirname(file), stdio: "pipe" });
  git("init"); git("config", "user.name", "Smoke"); git("config", "user.email", "smoke@example.invalid");
  git("add", "note.md"); git("commit", "-m", "baseline"); fs.appendFileSync(file, "\nEdited.");
  await launch("m6-security-change-size", file, [
    { nativeMenu: ["View", "Show Changes Since Last Commit"] },
    evaluate(`await waitFor(() => document.querySelector('#change-count').textContent === 'Change highlights are off above 2 MB.', 'Size note did not appear.'); assert(!document.querySelector('.change-highlight'), 'Large document was highlighted.');`),
  ]);
});

await test("m6b-watch-highlights", async () => {
  const before = "# Delivery plan\n\n## Ready\n\nThe foundation is complete.\n\n## Next\n\nReview the export path.\n";
  const after = before.replace("Review the export path.", "Review the export path and verify image containment.");
  const file = fixture("m6b-watch/note.md", before);
  const other = fixture("m6b-watch/other.md", "# Other\n");
  const marker = path.join(root, "m6b-watch-highlights", "armed.png");
  const audit = path.resolve(appRoot, "../.audit/m6b"); fs.mkdirSync(audit, { recursive: true });
  await launch("m6b-watch-highlights", file, [
    evaluate(`window.watchFocus = document.activeElement; window.watchScroll = document.querySelector('#read-scroll').scrollTop;`),
    { shot: marker },
    evaluate(`await waitFor(() => document.querySelector('#doc .change-highlight'), 'Clean rewrite did not show highlights.');
      assert(document.activeElement === window.watchFocus, 'Watch reload stole focus.');
      assert(document.querySelector('#read-scroll').scrollTop === window.watchScroll, 'Watch reload scrolled.');
      assert(document.querySelector('#doc .change-highlight').textContent.includes('image containment'), 'Wrong block highlighted.');
      assert(document.querySelectorAll('#doc .change-highlight').length === 1, 'Unchanged blocks highlighted.');
      assert(document.querySelector('#change-count').textContent === '1 change', 'Wrong change count.');
      assert(document.querySelector('#banner').hidden, 'Clean rewrite entered conflict flow.');`),
    { shot: path.join(audit, "watch-highlights.png") },
    evaluate(`window.simplemd.command('toggle-edit'); await waitFor(() => document.querySelector('.cm-line.change-highlight'), 'Editor has no source-range highlight.');`),
    { shot: path.join(audit, "watch-editor.png") },
    evaluate(`window.simplemd.command('mark-seen'); await waitFor(() => document.querySelector('#changes').hidden, 'Mark Seen did not clear marks.');
      assert(!document.querySelector('.cm-line.change-highlight'), 'Editor marks survived Mark Seen.');`),
    evaluate(`const id = Number(document.querySelector('.document-pane').dataset.documentId);
      assert((await window.simplemd.gitStatus(id)).available, 'Saved file lacks an optimistic Git action.');
      assert(!(await window.simplemd.headChanges(id, true)).available, 'Outside-repo HEAD read succeeded.');
      await window.simplemd.openPath(${quote(other)}, 'read');
      await window.simplemd.openPath(${quote(file)}, 'read');`),
    { nativeMenuState: { path: ['View', 'Show Changes Since Last Commit'], enabled: true, checked: false, tooltip: true } },
    { nativeMenu: ['View', 'Show Changes Since Last Commit'] },
    evaluate(`await waitFor(() => document.querySelector('#toast').textContent.includes('not in a Git repository'), 'Outside-repo Git action did not explain the failure.');`),
    { nativeMenuState: { path: ['View', 'Show Changes Since Last Commit'], enabled: true, checked: false } },
  ], "read", { marker, file, text: after });
  assert.equal(fs.readFileSync(file, "utf8"), after, "Watch or Mark Seen changed source bytes.");
});

for (const away of [false, true]) await test(`m6b-watch-tab-${away ? "unread" : "seen"}`, async () => {
  const file = fixture(`m6b-tab-${away}/plan.md`, "# Plan\n\nBefore\n");
  const other = fixture(`m6b-tab-${away}/other.md`, "# Other\n");
  const name = `m6b-watch-tab-${away ? "unread" : "seen"}`;
  const marker = path.join(root, name, "armed.png");
  await launch(name, file, [
    ...(away ? [evaluate(`await window.simplemd.openPath(${quote(other)}, 'read');`)] : []),
    { shot: marker },
    evaluate(away ? `await new Promise(resolve => setTimeout(resolve, 300));
      await window.simplemd.openPath(${quote(file)}, 'read');
      await waitFor(() => document.querySelector('#doc .change-highlight'), 'An update received while away was marked seen.');`
      : `await waitFor(() => document.querySelector('#doc .change-highlight'), 'Watch marks did not appear.');
      await new Promise(resolve => setTimeout(resolve, 1200));
      await window.simplemd.openPath(${quote(other)}, 'read');
      await window.simplemd.openPath(${quote(file)}, 'read');
      await waitFor(() => document.querySelector('#changes').hidden, 'Returning after reading did not mark seen.');`),
  ], "read", { marker, file, text: "# Plan\n\nAfter\n" });
});

await test("m6b-git-head-highlights", async () => {
  const committed = "# Delivery plan\n\n## Ready\n\nThe foundation is complete.\n\nAn obsolete step.\n\n## Next\n\nReview the export path.\n";
  const current = committed.replace("An obsolete step.\n\n", "").replace("Review the export path.", "Review the export path and verify image containment.");
  const file = fixture("m6b-git/plan.md", committed);
  const dir = path.dirname(file);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init"); git("config", "user.name", "Smoke"); git("config", "user.email", "smoke@example.invalid");
  git("add", "--", file); git("commit", "-m", "fixture"); fs.writeFileSync(file, current);
  const audit = path.resolve(appRoot, "../.audit/m6b"); fs.mkdirSync(audit, { recursive: true });
  await launch("m6b-git-head-highlights", file, [
    evaluate(`const id = Number(document.querySelector('.document-pane').dataset.documentId);
      assert((await window.simplemd.gitStatus(id)).available, 'Git HEAD toggle is unavailable.');`),
    { nativeMenuState: { path: ["View", "Show Changes Since Last Commit"], enabled: true, checked: false } },
    { nativeMenu: ["View", "Show Changes Since Last Commit"] },
    evaluate(`await waitFor(() => document.querySelector('#doc .change-highlight') && document.querySelector('#doc .change-deleted'), 'Git HEAD changes did not render.');
      assert(document.querySelectorAll('#doc .change-highlight').length === 1, 'HEAD marked unchanged blocks.');
      assert(document.querySelector('#change-count').title === 'Since last commit', 'Wrong baseline source.');
      document.querySelector('#next-change').click(); document.querySelector('#previous-change').click();`),
    { shot: path.join(audit, "git-head-highlights.png") },
    evaluate(`window.simplemd.command('toggle-edit'); await waitFor(() => document.querySelector('.cm-line.change-highlight') && document.querySelector('.cm-line.change-deleted-before'), 'Git editor marks did not render.');`),
    { nativeMenu: ["View", "Show Changes Since Last Commit"] },
    evaluate(`await waitFor(() => document.querySelector('#changes').hidden, 'Turning HEAD off kept highlights.');`),
  ]);
  assert.equal(fs.readFileSync(file, "utf8"), current);
});

await test("m6b-drag-export", async () => {
  const source = '# Finished export\n\n![Local](image.png)\n\n<strong>Safe text</strong>\n\n<script>window.bad = true</script>\n';
  const file = fixture("m6b-drag/note.md", source);
  fs.writeFileSync(path.join(path.dirname(file), "image.png"), png);
  const html = path.join(root, "drag-result.html"), pdf = path.join(root, "drag-result.pdf");
  const htmlReceipt = path.join(root, "html-drag.json"), pdfReceipt = path.join(root, "pdf-drag.json");
  await launch("m6b-drag-export", file, [
    { dragExport: { format: "html", target: html, receipt: htmlReceipt } },
    evaluate(`assert(document.querySelector('#drag-export').draggable, 'Finished HTML did not enable dragging.');
      window.simplemd.command('toggle-edit'); await waitFor(() => document.querySelector('.cm-content'), 'Editor did not open.');
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({changes: {from: view.state.doc.length, insert: '\\nEdited export.\\n'}});
      assert(!document.querySelector('#drag-export').draggable, 'An edit left a stale export draggable.');`),
    { dragExport: { format: "pdf", target: pdf, receipt: pdfReceipt } },
  ]);
  const exported = fs.readFileSync(html, "utf8");
  assert(exported.includes('data:image/png;base64,') && exported.includes('<strong>Safe text</strong>'), "HTML drag lost images or safe markup.");
  assert(!/<script\b|src=["']file:/i.test(exported), "Drag HTML retained executable markup or local resource paths.");
  assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), "%PDF-");
  for (const receipt of [htmlReceipt, pdfReceipt]) assert(!fs.existsSync(JSON.parse(fs.readFileSync(receipt, "utf8")).file), "Temporary drag export survived normal exit.");
  assert.equal(fs.readFileSync(file, "utf8"), source, "Drag export changed source bytes.");
});

for (const paneCount of [1, 2]) await test(`m6b-highlighted-typing-${paneCount}`, async () => {
  const before = ("# Highlighted plan\n\n" + Array.from({length: 300}, (_, i) => `Paragraph ${i} ` + "Read and verify this change. ".repeat(20)).join("\n\n")).slice(0, 100000);
  const text = before.replace("Paragraph 75 ", "Paragraph XX ");
  const at = text.indexOf("Paragraph XX"); assert(at > 0);
  const file = fixture(`m6b-typing-${paneCount}/plan.md`, before);
  const companion = fixture(`m6b-typing-${paneCount}/companion.md`, text);
  const dir = path.dirname(file);
  const git = (...args: string[]) => execFileSync("git", args, {cwd: dir, stdio: "pipe"});
  git("init"); git("config", "user.name", "Smoke"); git("config", "user.email", "smoke@example.invalid");
  git("add", "--", file); git("commit", "-m", "fixture"); fs.writeFileSync(file, text);
  const steps: Step[] = [{diagnostics: "environment"}, evaluate(`
    window.typingId = Number(document.querySelector('.document-pane').dataset.documentId);
    if (${paneCount} === 2) {
      await window.simplemd.openPath(${quote(companion)}, 'edit'); await window.simplemd.activateTab(window.typingId);
      await waitFor(() => document.documentElement.dataset.documentPath === ${quote(file)}, 'Typing tab did not return.');
      window.simplemd.command('split-panes'); await waitFor(() => document.querySelectorAll('.cm-editor').length === 2, 'Second editor did not open.');
    }
    const pane = document.querySelector('.document-pane[data-document-id="' + window.typingId + '"]');
    const content = pane.querySelector('.cm-content'), view = content.cmTile.root.view;
    window.typingView = view;
    assert(view.state.doc.length === 100000, 'Typing fixture is not 100k.');
    await window.simplemd.focusPane(Number(pane.dataset.paneId));
    await window.simplemd.gitStatus(window.typingId); window.simplemd.command('toggle-head-changes', window.typingId);
    view.dispatch({selection: {anchor: ${at}}, scrollIntoView: true}); view.focus();
    await waitFor(() => pane.querySelector('.cm-line.change-highlight'), 'Active editor marks did not render.');
    ${typingProbe}
  `)];
  for (const letter of typingLetters) steps.push(...typingInput(letter, "native"), {wait: 25});
  steps.push({wait: 250}, evaluate(`assert(window.perfCounts.keydown === ${typingLetters.length} && window.perfCounts.beforeinput === ${typingLetters.length}, 'Trusted key count differs.');
    assert(window.typingView.state.doc.toString() === ${quote(text.slice(0, at) + typingLetters + text.slice(at))}, 'Highlighted typing lost text.');`),
    {record: {name: "highlighted", eval: typingRecord}}, evaluate(`window.perfObserver.disconnect();
      const content = document.createElement('textarea'); content.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:1000'; document.body.append(content); content.focus();
      ${typingProbe}`));
  for (const letter of typingLetters) steps.push(...typingInput(letter, "native"), {wait: 25});
  steps.push({wait: 250}, evaluate(`assert(document.querySelector('textarea').value === ${quote(typingLetters)}, 'Control typing lost text.');`), {record: {name: "control", eval: typingRecord}});
  const name = `m6b-highlighted-typing-${paneCount}`;
  await launch(name, file, steps, "edit");
  const records = fs.readFileSync(path.join(root, name, "electron.log"), "utf8").split("\n").filter(line => line.startsWith("smd-perf ")).map(line => JSON.parse(line.slice(9))).filter(record => record.kind === "record");
  const value = (name: string) => records.find(record => record.name === name)?.value;
  const editor = summarizeEventTiming(value("highlighted")), control = summarizeEventTiming(value("control"));
  const frame = 1000 / value("environment").display.displayFrequency;
  const gate = calibratedTyping(editor.keydown.p95, control.keydown.p95, frame, editor.keydown.total);
  const receipt = { paneCount, chars: text.length, trustedKeys: editor.keydown.total, gate, editor, control, records };
  const audit = path.resolve(appRoot, "../.audit/m6b"); fs.mkdirSync(audit, {recursive: true});
  fs.writeFileSync(path.join(audit, `highlighted-typing-${paneCount}.json`), JSON.stringify(receipt, null, 2));
  assert.equal(gate.status, "pass", "Active highlights exceeded the calibrated typing budget.");
  assert.equal(fs.readFileSync(file, "utf8"), text, "Unsaved highlighted typing changed disk bytes.");
});

await test("normal-read-window", async () => {
  const file = fixture("normal-read-window/note.md", note);
  await launch("normal-read-window", file, [
    evaluate(`assert(document.querySelector('#edit').hidden, 'Read intent opened the editor.');
      const settings = (await window.simplemd.ready()).settings;
      for (const key of ['shortcut', 'spacePreview', 'peekPrompted']) assert(!(key in settings), 'Obsolete setting remains: ' + key);
      let rejected = false;
      try { await window.simplemd.openPath(${quote(file)}, 'peek'); } catch { rejected = true; }
      assert(rejected, 'Removed peek intent was accepted.');`),
    { input: { type: "keyDown", keyCode: "Space" } },
    { input: { type: "keyUp", keyCode: "Space" } },
    { wait: 100 },
    { visibility: true },
    { input: { type: "keyDown", keyCode: "Escape" } },
    { input: { type: "keyUp", keyCode: "Escape" } },
    { wait: 100 },
    { visibility: true },
    evaluate(`assert(document.querySelector('#edit').hidden, 'Dismiss keys changed the reading view.');`),
  ]);
});

await test("live-open-defers-read-render", async () => {
  const file = fixture("live-open/note.md", note);
  const previous = process.env.SMD_PERF;
  process.env.SMD_PERF = "1";
  try {
    await launch("live-open-defers-read-render", file, [
      evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(file)}, 'Live document did not paint.');
        assert(document.querySelector('#edit').dataset.mode === 'live', 'Live mode did not initialize.');
        assert(document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === ${quote(note)}, 'Live source differs.');`),
      { record: { name: "live-ready", eval: "true" } },
      evaluate(`window.simplemd.command('toggle-edit');
        await waitFor(() => !document.querySelector('#read').hidden && document.querySelector('#doc h1')?.textContent === 'Smoke edit note', 'Read view did not render after Live.');`),
    ], "edit", undefined, 0, "live");
  } finally {
    if (previous === undefined) delete process.env.SMD_PERF;
    else process.env.SMD_PERF = previous;
  }
  const logs = fs.readFileSync(path.join(root, "live-open-defers-read-render/electron.log"), "utf8");
  const ready = logs.indexOf('"name":"live-ready"');
  assert(ready >= 0, "Missing Live readiness record.");
  assert(!logs.slice(0, ready).includes('"marker":"parse-start"'), "Live initialized an unused full-document render.");
  assert(!logs.slice(0, ready).includes('"marker":"worker-queue"'), "Live started an unused render worker.");
  assert(logs.slice(ready).includes('"marker":"parse-start"'), "Read did not request its render.");
  assert.equal(fs.readFileSync(file, "utf8"), note, "Live-to-read changed the source bytes.");
});

await test("quit-with-late-renderer-markers", async () => {
  const file = fixture("late-markers/first.md", "# First\n");
  const target = fixture("late-markers/second.md", "# Second\n\nA complete read view.\n");
  const previous = process.env.SMD_PERF;
  process.env.SMD_PERF = "1";
  try {
    await launch("quit-with-late-renderer-markers", file, [
      evaluate(`window.simplemd.onDoc(payload => { window.smokeQuitDocumentId = payload.documentId; });
        assert(await window.simplemd.openPath(${quote(target)}, 'read'), 'Second document did not open.');
        await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(target)}, 'Second document did not paint.');
        window.setInterval(() => window.simplemd.perfMarker(window.smokeQuitDocumentId, 'diagrams-ready'), 1);`),
      { menuQuit: true },
    ]);
  } finally {
    if (previous === undefined) delete process.env.SMD_PERF;
    else process.env.SMD_PERF = previous;
  }
  const logs = fs.readFileSync(path.join(root, "quit-with-late-renderer-markers/electron.log"), "utf8");
  assert(logs.includes("quit-worker-stopped"), "Quit did not finish worker cleanup.");
  assert(!logs.includes("TypeError"), "Late markers reached the disposed document registry.");
});

await test("tabs-last-close-late-notifications", async () => {
  const name = "tabs-last-close-late-notifications";
  const file = fixture(`${name}/note.md`, note);
  await launch(name, file, [
    evaluate(`window.closedDocumentId = Number(document.documentElement.dataset.documentId);
      assert(await window.simplemd.closeTab(window.closedDocumentId), 'Last tab did not close.');
      await waitFor(() => !document.querySelector('.document-pane'), 'Closed pane survived.');
      window.simplemd.perfMarker(window.closedDocumentId, 'diagrams-ready');
      window.simplemd.documentReady(window.closedDocumentId);
      window.simplemd.editing(window.closedDocumentId);`),
    { wait: 100 }, { windowCount: 1 }, { visibility: false },
    { nativeMenuState: { path: ['View', 'Show Changes Since Last Commit'], enabled: false, checked: false } },
    evaluate(`await window.simplemd.openPath(${quote(file)}, 'read');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(file)}, 'Resident window did not reopen after late notifications.');`),
    { windowCount: 1 }, { visibility: true },
  ], "read", undefined, 0, "source", { env: { SMD_PERF: "1" } });
  assert.deepEqual(fs.readFileSync(file), Buffer.from(note));
  assert(!fs.readFileSync(path.join(root, name, 'electron.log'), 'utf8').includes('TypeError'), 'Late notification reached the closed session.');
});

await test("driver-assertion-failure", async () => {
  const file = fixture("driver-check/note.md", note);
  await launch("driver-assertion-failure", file, [
    { assert: "false /* SMOKE_EXPECTED_DRIVER_FAILURE */" },
  ], "read", undefined, 1);
  assert.equal(fs.readFileSync(file, "utf8"), note, "Failed driver changed its source note.");
});

await test("security-links", async () => {
  const file = fixture("security-links/project/note.md", '# Contained links\n\n[Outside](../../outside.md)\n\n![Outside](../../outside.png)\n');
  fs.mkdirSync(path.join(path.dirname(file), ".git"));
  const outside = fixture("security-links/outside.md", "# PRIVATE");
  const escape = path.join(path.dirname(file), "escape.md");
  fs.symlinkSync(outside, escape);
  await launch("security-links", file, [evaluate(`
    await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Contained links', 'Security note did not render.');
    assert(!document.querySelector('#doc a[href]'), 'Climbing link is active.');
    assert(!document.querySelector('#doc img').hasAttribute('src'), 'Climbing image has a URL.');
    assert(await window.simplemd.openLink(${quote('file://' + outside)}) === false, 'Cmd-click file link escaped the root.');
    assert(await window.simplemd.openLink(${quote('file://' + escape)}) === false, 'Symlink link escaped the root.');
    assert(document.querySelector('#doc h1').textContent === 'Contained links', 'Refused link changed the document.');
  `)]);
});

await test("streamed-large-export", async () => {
  const source = '# Full streamed export\n\n' + 'A paragraph with **bold** text. '.repeat(20).concat('\n\n').repeat(600) + '## Final export sentinel\n';
  const file = fixture('streamed-large-export/note.md', source);
  const html = path.join(root, 'streamed-large-export/output.html');
  await launch('streamed-large-export', file, [
    evaluate(`await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Full streamed export', 'Readable prefix did not arrive.');`),
    { html },
  ]);
  assert(fs.readFileSync(html, 'utf8').includes('Final export sentinel'), 'Export stopped at the readable prefix.');
  assert.equal(fs.readFileSync(file, 'utf8'), source, 'Streaming export changed the source.');
});

await test("security-export", async () => {
  const file = fixture("security-export/project/note.md", '# Export containment\n\n[Local](next.md)\n\n<picture><source srcset="pixel.png 1x"><img src="pixel.png"></picture>\n\n![Missing](missing.png)\n\n![Unsupported](image.tiff)\n\n![Escape](escape.png)\n');
  const dir = path.dirname(file);
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "pixel.png"), png);
  fs.writeFileSync(path.join(dir, "image.tiff"), "unsupported");
  const secret = fixture("security-export/private.png", "PRIVATE_IMAGE_BYTES");
  fs.symlinkSync(secret, path.join(dir, "escape.png"));
  const html = path.join(root, "security-export/output.html");
  await launch("security-export", file, [evaluate(`
    await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Export containment', 'Export note did not render.');
    await waitFor(() => document.querySelector('#doc picture img')?.naturalWidth > 0, 'Local srcset image did not load.');
  `), { html }]);
  const exported = fs.readFileSync(html, "utf8");
  assert(!exported.includes('file:'), 'Export leaked absolute local URLs.');
  assert(exported.includes('data:image/png;base64,' + png.toString('base64')), 'Local srcset candidate was not embedded.');
  assert(!exported.includes(Buffer.from('PRIVATE_IMAGE_BYTES').toString('base64')), 'Export read a symlink outside the root.');
  const logs = fs.readFileSync(path.join(root, 'security-export/electron.log'), 'utf8');
  assert(logs.includes('skipped export image'), 'Skipped images did not produce warnings.');
});

await test("split-prepared-blocks", async () => {
  const file = fixture("split-prepared-blocks/note.md", "# Prepared split\n\nReadable preview.\n");
  await launch("split-prepared-blocks", file, [
    evaluate(`assert(document.querySelector('#edit').dataset.mode === 'split', 'Side by side did not initialize.');
      assert(document.querySelector('#preview h1')?.textContent === 'Prepared split', 'Prepared blocks did not mount.');
      assert(document.querySelector('.cm-content'), 'The source editor did not mount.');`),
  ], "edit", undefined, 0, "split");
  const logs = fs.readFileSync(path.join(root, "split-prepared-blocks/electron.log"), "utf8");
  assert(!logs.includes("render-done"), "Side by side initialization requested a second full render.");
});

await test("mdx-ranges-only", async () => {
  const file = fixture("mdx-ranges-only/note.mdx", '# Ranges only\n\n<Widget value={1} />\n');
  await launch("mdx-ranges-only", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content'), 'Source MDX did not open.');
      await window.simplemd.setSettings({ mode: 'live' });
      assert(await window.simplemd.openPath(${quote(file)}, 'edit'), 'Live MDX did not reopen.');
      window.simplemd.command('mode-source');`),
    ...appendCharacter('!'),
    { wait: 500 },
    evaluate("window.simplemd.command('mode-live');"),
    ...appendCharacter('?'),
    { wait: 500 },
  ], "edit");
  const logs = fs.readFileSync(path.join(root, 'mdx-ranges-only/electron.log'), 'utf8');
  assert((logs.match(/doc-sent name=note.mdx blocks=0 intent=edit/g) ?? [] ).length === 1, 'Focusing existing MDX reopened or fully rendered it.');
  assert(logs.split('mdx-ranges-done').length >= 3, 'Source and Live did not request ranges.');
  assert(!logs.includes('render-done'), 'Source or Live requested a full MDX render.');
});

await test("render-links-pdf", async () => {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const source = "# Smoke render alpha\n\n## [Introduction](https://example.com)\n\n[Jump](#introduction)\n\n![image](image%20%231.png)\n\n[Next](../beta/note%20%231.md#target-section)\n\n```ts\nconst smoke = 42;\n```\n\nInline $E=mc^2$.\n\n```mermaid\ngraph LR\nStart-->Finish\n```\n\n<script>window.smokeInjected = true</script>\n\n[unsafe](javascript:alert(1))\n";
  const alpha = fixture("alpha/note.md", source);
  const beta = fixture("beta/note #1.md", "# Smoke render beta\n\n![image](image%20%231.png)\n\n" + "Before the target.\n\n".repeat(40) + "## Target section\n\n" + "After the target.\n\n".repeat(30));
  fs.writeFileSync(path.join(root, "alpha/image #1.png"), png);
  fs.writeFileSync(path.join(root, "beta/image #1.png"), png);
  const pdf = path.join(root, "render-links-pdf/output.pdf");
  const html = path.join(root, "render-links-pdf/output.html");
  await launch("render-links-pdf", alpha, [
    evaluate(`await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render alpha', 'Initial note did not render.');
      assert(document.documentElement.dataset.firstReadable === ${quote(alpha)}, 'First-readable marker is missing.');
      assert(document.querySelector('#edit').hidden, 'Reading view opened an editor.');
      await waitFor(() => document.querySelector('#doc .shiki'), 'Shiki code did not render.');
      assert(document.querySelector('#doc .katex'), 'KaTeX did not render.');
      assert(document.querySelector('#doc #user-content-introduction'), 'Linked heading has no matching fragment target.');
      await waitFor(() => document.querySelector('#doc .diagram svg'), 'Pele diagram did not render.');
      await waitFor(() => document.querySelector('#doc img')?.naturalWidth > 0, 'Relative image with a hash in its filename did not load.');
      assert(!document.querySelector('#doc script, #doc [onerror]'), 'Raw HTML became active DOM.');
      assert(!window.smokeInjected, 'Raw Markdown script executed.');
      assert(!document.querySelector('#doc a[href^="javascript:"]'), 'Unsafe link became clickable.');
      assert(typeof window.require === 'undefined', 'Renderer has Node require.');
      await waitFor(() => !document.querySelector('#read').inert && !document.querySelector('#edit').inert && document.documentElement.dataset.documentPainted === ${quote(alpha)}, 'Initial note transition did not finish.', 30000);
      document.querySelector('#doc a[href*="note%20%231.md"]').click();
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render beta' && document.documentElement.dataset.documentPainted === ${quote(beta)} && !document.querySelector('#read').inert && !document.querySelector('#edit').inert, 'Encoded Markdown link did not commit.', 30000);
      await waitFor(() => document.querySelector('#read-scroll').scrollTop > 500, 'Cross-file fragment did not scroll.');
      const targetTop = document.querySelector('#doc #user-content-target-section').getBoundingClientRect().top;
      const viewport = document.querySelector('#read-scroll').getBoundingClientRect();
      assert(targetTop >= viewport.top && targetTop < viewport.top + 100, 'Cross-file heading is not at the viewport start.');
      await waitFor(() => document.querySelector('#doc img')?.naturalWidth > 0, 'Image did not resolve after navigation.');
      assert(document.querySelector('#doc img').src.includes('/beta/'), 'Navigation kept the previous image base path.');
      window.simplemd.command('nav-back');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render alpha' && !document.querySelector('#edit').inert, 'Back navigation failed.');
      window.simplemd.command('nav-forward');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render beta' && !document.querySelector('#edit').inert, 'Forward navigation failed.');
      window.simplemd.command('nav-back');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render alpha' && !document.querySelector('#edit').inert, 'Return to export note failed.');`),
    { pdf },
    { html },
  ]);
  assert.equal(fs.readFileSync(alpha, "utf8"), source, "Reading or navigation changed the source note.");
  assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), "%PDF-", "PDF output is invalid.");
  const pdftotext = Bun.which("pdftotext");
  assert(pdftotext, "Install pdftotext to verify PDF content. The smoke does not treat a PDF header as rendering proof.");
  const extracted = Bun.spawnSync([pdftotext, pdf, "-"]);
  assert.equal(extracted.exitCode, 0, "PDF text extraction failed.");
  const text = extracted.stdout.toString();
  assert(text.includes("Smoke render alpha") && text.includes("smoke") && text.includes("Start") && text.includes("Finish"), "PDF is missing note, code or diagram content.");
  const pdfimages = Bun.which("pdfimages");
  assert(pdfimages, "pdfimages is required to verify the exported local image.");
  const images = Bun.spawnSync([pdfimages, "-list", pdf]);
  assert.equal(images.exitCode, 0, "PDF image inspection failed.");
  assert(/^\s*\d+\s+\d+\s+image\s+/m.test(images.stdout.toString()), "PDF omitted the local image.");
  const exported = fs.readFileSync(html, "utf8");
  assert(exported.includes("Smoke render alpha") && exported.includes("shiki") && exported.includes("katex"), "HTML omitted rendered note content.");
  assert(/<svg\b/.test(exported) && !/<pre class="mermaid"/.test(exported), "HTML retained Mermaid source instead of its SVG.");
  assert(exported.includes(`data:image/png;base64,${png.toString("base64")}`), "HTML did not embed the exact local image bytes.");
  assert(!/\bsrc=["']file:/i.test(exported), "HTML still depends on local image paths.");
  assert(!exported.includes("url(fonts/") && /url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)/.test(exported), "HTML font embedding is incomplete.");
  assert(!/<script\b/i.test(exported), "Static HTML export contains an active script.");
});

await test("github-theme-images", async () => {
  const name = "github-theme-images";
  fixture(`${name}/dark.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"><rect width="13" height="13" fill="black"/></svg>');
  fixture(`${name}/light.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17"><rect width="17" height="17" fill="white"/></svg>');
  const source = '# Theme images\n\n<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"><source media="(prefers-color-scheme: light)" srcset="light.svg"><img src="light.svg" alt="picture"></picture>\n\n![dark](dark.svg#gh-dark-mode-only) ![light](light.svg#gh-light-mode-only)\n';
  const file = fixture(`${name}/note.md`, source);
  await launch(name, file, [evaluate(`
    await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(file)}, 'Theme fixture did not open.');
    for (const theme of ['light', 'dark', 'light']) {
      await window.simplemd.setSettings({ theme });
      await waitFor(() => document.documentElement.dataset.theme === theme, 'App theme did not update.');
      const picture = document.querySelector('#doc picture img');
      await waitFor(() => picture.currentSrc.endsWith('/' + theme + '.svg') && picture.naturalWidth === (theme === 'dark' ? 13 : 17), 'Picture did not load the app theme source.');
      assert((getComputedStyle(document.querySelector('#doc img[alt="dark"]')).display !== 'none') === (theme === 'dark'), 'Dark fragment visibility disagrees with app theme.');
      assert((getComputedStyle(document.querySelector('#doc img[alt="light"]')).display !== 'none') === (theme === 'light'), 'Light fragment visibility disagrees with app theme.');
    }
  `)]);
  assert.equal(fs.readFileSync(file, "utf8"), source, "Theme changes changed the source note.");
});

await test("author-html", async () => {
  fixture("author/site/astro.config.mjs", "");
  const publicImage = path.join(root, "author/site/public/images/pixel.png");
  fs.mkdirSync(path.dirname(publicImage), { recursive: true });
  fs.writeFileSync(publicImage, png);
  const file = fixture("author/site/docs/note.md", `# Author HTML

<details id="more" open class="mermaid" style="display:none" data-evil="yes">
<summary>More</summary>

**Inside**

- [x] Safe task

~~~ts
const safe = 1
~~~

$x^2$

</details>

[More](#more)

![Local](/images/pixel.png)

<img alt="raw" src="/images/pixel.png" onerror="window.authorExecuted=true">
<img alt="blocked" src="file:///tmp/secret.png">
<img alt="remote" src="https://example.invalid/remote.png">
<pre class="mermaid" data-evil="yes">fake</pre>
<script>window.authorExecuted = true</script>
`);
  const pdf = path.join(root, "author-html/output.pdf");
  const html = path.join(root, "author-html/output.html");
  await launch("author-html", file, [
    evaluate(`await waitFor(() => document.querySelector('#doc details:not(.frontmatter) strong')?.textContent === 'Inside', 'Raw wrapper lost its Markdown children.');
      const doc = document.querySelector('#doc');
      await waitFor(() => doc.querySelector('details .shiki'), 'Nested Shiki code did not render.');
      assert(doc.querySelector('details .shiki') && doc.querySelector('details .katex') && doc.querySelector('details input[type="checkbox"][disabled]'), 'Author policy removed generated nodes.');
      assert(!doc.querySelector('script, style, [data-evil], [onerror], .mermaid') && !window.authorExecuted, 'Author content gained generated privileges.');
      assert(doc.querySelector('details').id === 'user-content-more' && doc.querySelector('a[href="#user-content-more"]'), 'Author IDs and fragments disagree.');
      assert(!doc.querySelector('img[alt="blocked"]').hasAttribute('src'), 'Author file URL survived.');
      await waitFor(() => [...doc.querySelectorAll('img[alt="Local"], img[alt="raw"]')].every(image => image.naturalWidth > 0), 'Astro root images did not load.');
      assert(doc.querySelector('img[alt="Local"]').src.includes('/site/public/images/'), 'Root image used the wrong ancestor.');
      assert(doc.querySelector('img[alt="remote"]').getAttribute('src') === 'https://example.invalid/remote.png', 'Remote images are not enabled by default.');
      window.simplemd.command('preferences');`),
    { settings: [evaluate(`await waitFor(() => document.querySelector('#remote-images') && !document.querySelector('#remote-images').disabled, 'Settings did not open.');
      assert((await window.simplemdSettings.get()).settings.remoteImages, 'Remote images are not on by default.');
      await window.simplemdSettings.set({ remoteImages: false });`)] },
    evaluate(`await waitFor(() => { const image = document.querySelector('#doc img[alt="remote"]'); return image && !image.hasAttribute('src'); }, 'Remote image remains enabled.');
      assert(!(await window.simplemd.ready()).settings.remoteImages, 'Remote image preference did not persist.');`),
    { pdf },
    { html },
  ]);
  assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), "%PDF-");
  const exported = fs.readFileSync(html, "utf8");
  assert(/<details\b(?=[^>]*\bid="user-content-more")(?=[^>]*\bopen="")/.test(exported) && exported.includes("<strong>Inside</strong>"), "HTML export lost the sanitized author wrapper.");
  assert(exported.includes('href="#user-content-more"') && exported.includes('type="checkbox"') && exported.includes('class="shiki') && exported.includes('class="katex"'), "HTML export lost fragments or generated markup.");
  assert(!/<script\b|\bonerror=|data-evil=|src=["'](?:file:|https?:)/i.test(exported), "HTML export retained blocked author markup or resource URLs.");
  const pdftotext = Bun.which("pdftotext");
  assert(pdftotext, "pdftotext is required to verify the sanitized PDF content.");
  const extracted = Bun.spawnSync([pdftotext, pdf, "-"]);
  assert.equal(extracted.exitCode, 0);
  assert(extracted.stdout.toString().includes("Inside") && extracted.stdout.toString().includes("Safe task"), "PDF export lost the sanitized author wrapper content.");
});

await test("edit-modes-undo-save", async () => {
  const file = fixture("edit/note.md", note);
  await launch("edit-modes-undo-save", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content'), 'CLI edit did not open CodeMirror.');
      for (const mode of ['live', 'split', 'source']) {
        document.querySelector('[data-mode="' + mode + '"][aria-pressed]').click();
        await waitFor(() => document.querySelector('#edit').dataset.mode === mode, 'Mode did not switch to ' + mode);
        if (mode === 'split') await waitFor(() => document.querySelector('#preview h1')?.textContent === 'Smoke edit note', 'Split preview did not render the current note.');
      }
      assert(document.querySelector('#dirty').hidden, 'Changing modes dirtied the source.');`),
    ...appendCharacter("!"),
    evaluate(`window.simplemd.command('undo');
      await waitFor(() => !editorText().includes('!'), 'Undo did not remove the edit.');
      window.simplemd.command('redo');
      await waitFor(() => editorText().endsWith('!'), 'Redo did not restore the edit.');
      window.simplemd.command('save');
      await waitFor(() => document.querySelector('#dirty').hidden, 'Save did not acknowledge the current text.');`),
  ], "edit");
  assert.equal(fs.readFileSync(file, "utf8"), `${note}!`, "Saved bytes differ from the edited note.");
});

await test("autosave-persist", async () => {
  const file = fixture("autosave/note.md", note);
  await launch("autosave-persist", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content'), 'Editor did not open.');
      await window.simplemd.setSettings({ autosave: true });`),
    ...appendCharacter("!"),
    evaluate("await waitFor(() => document.querySelector('#dirty').hidden, 'Autosave did not acknowledge the edit.');"),
  ], "edit");
  assert.equal(fs.readFileSync(file, "utf8"), `${note}!`, "Autosave did not persist the edited bytes.");
});

await test("settings-menu-quit", async () => {
  const name = "settings-menu-quit";
  const file = fixture(`${name}/note.md`, note);
  await launch(name, file, [
    evaluate(`window.simplemd.command('preferences');`),
    { settings: [evaluate(`await window.simplemdSettings.set({ theme: 'light' });
      await waitFor(() => !matchMedia('(prefers-color-scheme: dark)').matches, 'Light setting did not change appearance.');
      await window.simplemdSettings.set({ theme: 'dark', mode: 'split', readingFontFamily: 'Charter', contentWidth: 100, autosave: true, spellcheck: false });
      await waitFor(() => matchMedia('(prefers-color-scheme: dark)').matches, 'Dark setting did not change appearance.');`),
      { shot: path.join(root, name, "settings.png") },
    ] },
    evaluate(`await waitFor(() => document.querySelector('[data-mode="split"]').getAttribute('aria-pressed') === 'true', 'Editing default did not apply.');
      await waitFor(() => document.querySelector('#preview h1')?.textContent === 'Smoke edit note', 'Side by side did not render after Settings.');`),
    { menuQuit: true },
  ], "edit");
  const { parseConfig } = await import("../src/shared/config");
  const saved = parseConfig(fs.readFileSync(path.join(root, name, "profile/config"), "utf8")).settings;
  assert.equal(saved.theme, "dark");
  assert.equal(saved.mode, "split");
  assert.equal(saved.readingFontFamily, "Charter");
  assert.equal(saved.contentWidth, 100);
  assert.equal(saved.autosave, true);
  assert.equal(saved.spellcheck, false);
  const state = JSON.parse(fs.readFileSync(path.join(root, name, "profile/settings.json"), "utf8"));
  assert(!('theme' in state) && !('mode' in state), 'User settings remain in settings.json.');
  assert.equal(fs.readFileSync(file, "utf8"), note, "Settings or menu quit changed the note.");
});

await test("cache-same-stat", async () => {
  const before = "# Cache BEFORE\n";
  const after = "# Cache AFTER!\n";
  assert.equal(before.length, after.length);
  const alpha = fixture("cache/alpha.md", before);
  const timestamp = new Date("2020-01-02T03:04:05.000Z");
  fs.utimesSync(alpha, timestamp, timestamp);
  const beta = fixture("cache/beta.md", "# Cache other note\n");
  const marker = path.join(root, "cache-same-stat", "armed.png");
  await launch("cache-same-stat", alpha, [
    evaluate(`assert(document.querySelector('#doc h1')?.textContent === 'Cache BEFORE', 'Cache fixture did not open.');
      await window.simplemd.openPath(${quote(beta)}, 'read');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Cache other note', 'Second cache fixture did not open.');`),
    { shot: marker },
    evaluate(`await new Promise(resolve => setTimeout(resolve, 250));
      await window.simplemd.openPath(${quote(alpha)}, 'read');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Cache AFTER!', 'Same-size, same-mtime replacement returned cached content.');`),
  ], "read", { marker, file: alpha, text: after, preserveTimes: true });
  assert.equal(fs.readFileSync(alpha, "utf8"), after);
});

await test("mdx-editing", async () => {
  const source = '\uFEFFimport Widget from "./widget"\r\n\r\n# Smoke MDX\r\n\r\n<Card value={1}>\r\n\r\n**inside** and $x$\r\n\r\n![inside](missing.png)\r\n\r\n</Card>\r\n\r\nOutside.\n';
  const file = fixture("mdx-editing/note.mdx", source);
  await launch("mdx-editing", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content[contenteditable="true"]'), 'MDX did not enter editing.');
      const v = document.querySelector('.cm-content').cmTile.root.view;
      window.mdxView = v;
      assert(document.querySelector('.cm-mdx-esm'), 'ESM syntax is not highlighted.');
      assert(document.querySelector('.cm-mdx-tag-name'), 'JSX syntax is not highlighted.');
      for (const mode of ['live', 'source', 'split']) {
        window.simplemd.command('mode-' + mode);
        await waitFor(() => document.querySelector('#edit').dataset.mode === mode, 'MDX mode did not switch.');
        if (mode === 'live') {
          assert(document.querySelector('.cm-content').textContent.includes('**inside** and $x$'), 'Live hid markers inside JSX.');
          assert(!document.querySelector('.cm-rendered, .cm-image, .cm-math-inline'), 'Live made a widget inside JSX.');
        }
      }
      await waitFor(() => document.querySelector('#preview .mdx-component'), 'Component box did not render.');
      const at = v.state.doc.toString().indexOf('value={1}') + 8;
      v.dispatch({ changes: { from: at, insert: '0' }, userEvent: 'input.type' });
      assert(v.state.doc.toString().includes('value={10}'), 'Edit inside MDX failed.');
      window.simplemd.command('mode-live');
      await waitFor(() => document.querySelector('#edit').dataset.mode === 'live', 'Live did not return after editing.');
      await new Promise(resolve => setTimeout(resolve, 300));
      assert(document.querySelector('.cm-content').textContent.includes('**inside** and $x$'), 'Reparse hid markers inside edited JSX.');
      assert(!document.querySelector('.cm-rendered, .cm-image, .cm-math-inline'), 'Reparse made a widget inside JSX.');`),
    { save: true },
    ...appendCharacter("!"),
    { save: true },
    evaluate(`window.simplemd.command('toggle-edit');
      await waitFor(() => !document.querySelector('#read').hidden, 'MDX did not enter read view.');
      await waitFor(() => document.querySelector('#doc .mdx-label')?.textContent === 'Card', 'Read component label is missing.');
      assert(!document.querySelector('#doc').textContent.includes('import Widget'), 'ESM is visible in read view.');`),
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(source.replace('value={1}', 'value={10}') + '!'), 'MDX edits changed untouched bytes.');
});

await test("mdx-invalid-recovery", async () => {
  const source = '# Stable MDX\n\n<Widget />\n\nOutside.\n';
  const file = fixture("mdx-invalid-recovery/note.mdx", source);
  await launch("mdx-invalid-recovery", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content'), 'MDX editor did not open.');
      window.simplemd.command('mode-split');
      await waitFor(() => document.querySelector('#preview .mdx-component'), 'Good preview is missing.');
      const v = document.querySelector('.cm-content').cmTile.root.view;
      window.mdxView = v;
      v.dispatch({ changes: { from: v.state.doc.length, insert: '\\n\\n<Broken value={' }, userEvent: 'input.paste' });
      await waitFor(() => document.querySelector('#preview .mdx-error'), 'Incomplete MDX error is missing.');
      assert(document.querySelector('#preview .mdx-component .mdx-label').textContent === 'Widget', 'Last good component disappeared.');
      assert(document.querySelector('#preview .mdx-error pre').textContent.includes('<Broken value={'), 'Failing source was not escaped.');
      assert(!document.querySelector('#preview broken'), 'Invalid source became HTML.');`),
    { save: true },
    evaluate(`const v = window.mdxView;
      v.dispatch({ changes: { from: v.state.doc.length, insert: '1} />' }, userEvent: 'input.paste' });
      await waitFor(() => !document.querySelector('#preview .mdx-error') && [...document.querySelectorAll('#preview .mdx-label')].some(el => el.textContent === 'Broken'), 'Preview did not recover.');
      window.simplemd.command('undo');
      await waitFor(() => document.querySelector('#preview .mdx-error'), 'Undo did not restore the incomplete preview.');
      window.simplemd.command('undo');
      await waitFor(() => !document.querySelector('#preview .mdx-error') && v.state.doc.toString() === ${quote(source)}, 'Undo did not restore the original source.');`),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(source), 'Recovery and undo changed the original bytes.');
});

await test("tasks-source-mapping", async () => {
  const source = "# Smoke task mapping\n\n```md\n- [ ] code example\n```\n\n> - [ ] quoted task\n\n1) [ ] ordered task\n\n- [ ] last task\n";
  const file = fixture("tasks/note.md", source);
  await launch("tasks-source-mapping", file, [
    evaluate(`assert(document.querySelectorAll('#doc .task-list-item-checkbox').length === 3, 'Task fixture did not render three real checkboxes.');
      document.querySelector('#doc .task-list-item').click();
      await waitFor(() => document.querySelector('#doc .task-list-item-checkbox')?.checked, 'Quoted task did not toggle.');
      window.simplemd.command('save');
      await waitFor(() => document.querySelector('#dirty').hidden, 'Task edit did not save.');`),
  ]);
  assert.equal(fs.readFileSync(file, "utf8"), source.replace("> - [ ] quoted", "> - [x] quoted"), "Clicking the quoted task changed the wrong source text.");
});

for (const choice of ["Reload", "Keep mine"] as const) {
  const name = choice === "Reload" ? "conflict-reload" : "conflict-keep-mine";
  await test(name, async () => {
    const file = fixture(`${name}/note.md`, note);
    const marker = path.join(root, name, "dirty.png");
    const external = "# External atomic replacement\n\nWritten outside the editor.\n";
    await launch(name, file, [
      evaluate("await waitFor(() => document.querySelector('.cm-content'), 'Editor did not open.');"),
      ...appendCharacter("!"),
      { shot: marker },
      evaluate(`await waitFor(() => !document.querySelector('#banner').hidden, 'External atomic replacement did not show a conflict.');
        assert(!document.querySelector('.change-highlight'), 'Dirty conflict created watch highlights.');
        const button = [...document.querySelectorAll('#banner button')].find(button => button.textContent === ${quote(choice)});
        assert(button, 'Conflict choice is missing.');
        button.click();
        await waitFor(() => document.querySelector('#banner').hidden, 'Conflict choice did not dismiss the banner.');
        ${choice === "Reload"
          ? "await waitFor(() => editorText().includes('External atomic replacement'), 'Reload did not adopt disk text.'); assert(document.querySelector('#dirty').hidden, 'Reload left the document dirty.');"
          : "assert(editorText().endsWith('!'), 'Keep mine discarded local text.'); window.simplemd.command('save'); await waitFor(() => document.querySelector('#dirty').hidden, 'Keep mine did not authorize saving local text.');"}`),
    ], "edit", { marker, file, text: external });
    assert.equal(fs.readFileSync(file, "utf8"), choice === "Reload" ? external : `${note}!`, "Conflict resolution saved the wrong content.");
  });
}

const byteFixtures = path.join(appRoot, "test/fixtures/bytes");
for (const name of ["lf", "crlf", "cr", "mixed", "bom-crlf", "no-final-newline", "astral", "binary-looking"]) {
  await test(`bytes-roundtrip-${name}`, async () => {
    const original = fs.readFileSync(path.join(byteFixtures, `${name}.md`));
    const file = fixture(`bytes-roundtrip-${name}/note.md`, original.toString());
    await launch(`bytes-roundtrip-${name}`, file, [
      evaluate(`assert(document.querySelector('.cm-content'), 'UTF-8 fixture did not enter the editor.');
        assert(!document.querySelector('.cm-content').textContent.includes('\\uFEFF'), 'BOM is visible in the editor.');
        assert(document.querySelector('#dirty').hidden, 'Opening changed the source.');`),
      { save: true },
      ...appendCharacter("!"),
      { save: true },
      evaluate(`window.simplemd.command('undo');
        await waitFor(() => !editorText().endsWith('!'), 'Undo failed.');`),
      { save: true },
    ], "edit");
    assert.deepEqual(fs.readFileSync(file), original, "Open, save, edit, save, undo, save changed the original bytes.");
  });
}

for (const name of ["invalid-utf8", "utf16le-bom", "utf16be-bom", "utf16le", "utf16be"]) {
  await test(`bytes-readonly-${name}`, async () => {
    const original = fs.readFileSync(path.join(byteFixtures, `${name}.md`));
    const file = fixture(`bytes-readonly-${name}/note.md`, "");
    fs.writeFileSync(file, original);
    await launch(`bytes-readonly-${name}`, file, [
      evaluate(`assert(!document.querySelector('#banner').hidden && document.querySelector('#banner').textContent.includes('Not a UTF-8 text file. Read only.'), 'Encoding notice is missing.');
        window.simplemd.command('toggle-edit');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(!document.querySelector('.cm-content[contenteditable="true"]'), 'Unsupported encoding is editable.');
        const id = Number(document.documentElement.dataset.documentId);
        assert(await window.simplemd.save('overwrite', false, id) === null, 'Main process allowed an overwrite.');
        assert(await window.simplemd.save('overwrite', true, id) === null, 'Main process allowed Save As from a read-only document.');`),
    ], "edit");
    assert.deepEqual(fs.readFileSync(file), original, "Read-only source bytes changed.");
  });
}

for (const [name, ending] of [["crlf", "\r\n"], ["cr", "\r"], ["mixed", "\r\n"]] as const) {
  await test(`bytes-paste-${name}`, async () => {
    const original = fs.readFileSync(path.join(byteFixtures, `${name}.md`), "utf8");
    const file = fixture(`bytes-paste-${name}/note.md`, original);
    await launch(`bytes-paste-${name}`, file, [
      ...appendCharacter("!"),
      { paste: "first\nsecond\r\nthird\rfourth" },
      evaluate(`await waitFor(() => editorText().endsWith('fourth'), 'Paste did not reach the editor.');`),
      { save: true },
      evaluate(`window.simplemd.command('undo');
        await waitFor(() => editorText().endsWith('!'), 'Undo did not remove the paste.');
        window.simplemd.command('redo');
        await waitFor(() => editorText().endsWith('fourth'), 'Redo did not restore the paste.');`),
      { save: true },
    ], "edit");
    assert.deepEqual(fs.readFileSync(file), Buffer.from(`${original}!first${ending}second${ending}third${ending}fourth`));
  });
}

await test("bytes-table", async () => {
  const original = fs.readFileSync(path.join(byteFixtures, "irregular-table.md"), "utf8");
  const file = fixture("bytes-table/note.md", original);
  const key = (keyCode: string, modifiers: NonNullable<KeyboardInputEvent["modifiers"]> = []): Step[] => [
    { input: { type: "keyDown", keyCode, modifiers } },
    { input: { type: "keyUp", keyCode, modifiers } },
  ];
  await launch("bytes-table", file, [
    evaluate(`document.querySelector('.cm-content').focus();`),
    ...key("A", [mod]), ...key("Left"), ...key("Down"), ...key("Down"), ...key("Right"), ...key("Right"),
    ...key("Tab"), ...key("Tab", ["shift"]),
    evaluate(`assert(document.querySelector('#dirty').hidden, 'Table navigation changed the source.');`),
    { input: { type: "char", keyCode: "X" } },
    ...key("Tab"),
    { input: { type: "char", keyCode: "Y" } },
    ...key("Tab", ["shift"]), ...key("Tab"),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original.replace("one", "Xone").replace("two", "Ytwo")), "Table cell editing or navigation reformatted other cells or rows.");
});

await test("bytes-table-new-row", async () => {
  const original = fs.readFileSync(path.join(byteFixtures, "irregular-table.md"), "utf8");
  const file = fixture("bytes-table-new-row/note.md", original);
  const key = (keyCode: string, modifiers: NonNullable<KeyboardInputEvent["modifiers"]> = []): Step[] => [
    { input: { type: "keyDown", keyCode, modifiers } },
    { input: { type: "keyUp", keyCode, modifiers } },
  ];
  await launch("bytes-table-new-row", file, [
    evaluate(`document.querySelector('.cm-content').focus();`),
    ...key("A", [mod]), ...key("Left"), ...key("Down"), ...key("Down"), ...key("Down"),
    ...key("Tab"), ...key("Tab"),
    { save: true },
    evaluate(`window.simplemd.command('undo');
      await waitFor(() => editorText().split('\\n').length === 5, 'Table row undo failed.');
      window.simplemd.command('redo');
      await waitFor(() => editorText().split('\\n').length === 6, 'Table row redo failed.');`),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original.slice(0, -2) + "\r\n| | |\r\n"), "Adding a table row rewrote existing rows.");
});

await test("bytes-external-encoding", async () => {
  const file = fixture("bytes-external-encoding/note.md", note);
  const other = fixture("bytes-external-encoding/other.md", "# Other\n");
  const marker = path.join(root, "bytes-external-encoding", "dirty.png");
  const external = "# External\u0000text\n";
  await launch("bytes-external-encoding", file, [
    ...appendCharacter("!"),
    { shot: marker },
    evaluate(`await waitFor(() => document.querySelector('#banner').textContent.includes('Not a UTF-8 text file.'), 'Invalid external revision was not reported.');
      assert(!document.querySelector('.cm-content[contenteditable="true"]'), 'External invalid revision left the editor writable.');
      const id = Number(document.documentElement.dataset.documentId);
      assert(await window.simplemd.save('overwrite', false, id) === null, 'Invalid external bytes could be overwritten.');
      [...document.querySelectorAll('#banner button')].find(button => button.textContent === 'Reload').click();
      await waitFor(() => document.querySelector('#dirty').hidden, 'Explicit read-only reload did not settle local edits.');
      await window.simplemd.openPath(${quote(other)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPath === ${quote(other)}, 'Read-only reload trapped navigation.');`),
  ], "edit", { marker, file, text: external });
  assert.deepEqual(fs.readFileSync(file), Buffer.from(external), "Recovery overwrote invalid external bytes.");
});

await test("bytes-task", async () => {
  const original = "\uFEFF# Tasks\r\n\r\n- [ ] first\r- [X] second\n- [ ] third";
  const file = fixture("bytes-task/note.md", original);
  await launch("bytes-task", file, [
    evaluate(`document.querySelectorAll('#doc .task-list-item')[1].click();
      await waitFor(() => !document.querySelector('#dirty').hidden, 'Task did not toggle.');`),
    { save: true },
    evaluate(`window.simplemd.command('undo');
      await waitFor(() => document.querySelectorAll('#doc .task-list-item-checkbox')[1]?.checked, 'Task undo failed.');
      window.simplemd.command('redo');
      await waitFor(() => !document.querySelectorAll('#doc .task-list-item-checkbox')[1]?.checked, 'Task redo failed.');`),
    { save: true },
  ]);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original.replace("[X] second", "[ ] second")), "Task toggle changed bytes outside its marker.");
});

await test("bytes-in-flight-renders", async () => {
  const original = "\uFEFF# In-flight renders\r\n\r\n" + "```typescript\r\nconst value = 42;\r\n```\r\n\r\n".repeat(800) + "Tail";
  const file = fixture("bytes-in-flight-renders/note.md", original);
  await launch("bytes-in-flight-renders", file, [
    evaluate(`await window.simplemd.setSettings({ mode: 'split' });
      await waitFor(() => document.querySelector('#preview h1'), 'Initial preview did not render.');
      const id = Number(document.documentElement.dataset.documentId);
      const revision = Number(document.documentElement.dataset.revisionId);
      window.pendingRenders = Array.from({ length: 6 }, () => window.simplemd.renderBlocks(${quote(original)}, id, revision)
        .then(() => 'rendered', error => String(error)));
      document.querySelector('.cm-content').focus();`),
    { input: { type: "keyDown", keyCode: "A", modifiers: [mod] } },
    { input: { type: "keyUp", keyCode: "A", modifiers: [mod] } },
    { input: { type: "keyDown", keyCode: "Right" } },
    { input: { type: "keyUp", keyCode: "Right" } },
    ...[..."123456789"].map((keyCode): Step => ({ input: { type: "char", keyCode } })),
    evaluate(`await waitFor(() => editorText().endsWith('Tail123456789'), 'Rapid edits did not reach the editor.');
      const outcomes = await Promise.all(window.pendingRenders);
      assert(outcomes.some(outcome => outcome.includes('Stale document revision')), 'No in-flight render was rejected after typing.');
      await waitFor(() => document.querySelector('#preview').textContent.includes('Tail123456789'), 'Latest preview did not replace the old revision.');
      const id = Number(document.documentElement.dataset.documentId);
      const revision = Number(document.documentElement.dataset.revisionId);
      assert(revision >= 9, 'Rapid edits did not advance the document revision.');
      const stale = await window.simplemd.renderBlocks(${quote(original)}, id, revision - 1).then(() => false, () => true);
      assert(stale, 'Main accepted a stale render revision.');`),
    { save: true },
    evaluate(`assert(document.querySelector('#dirty').hidden, 'Rapid edits did not settle after save.');`),
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original + "123456789"), "An in-flight render changed the saved source bytes.");
});

await test("bytes-metadata", async () => {
  if (process.platform !== "darwin") return;
  const original = fs.readFileSync(path.join(byteFixtures, "metadata.md"));
  const file = fixture("bytes-metadata/note.md", original.toString());
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(args);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    return result.stdout.toString();
  };
  const tag = '<?xml version="1.0"?><plist version="1.0"><array><string>SimpleMD\n6</string></array></plist>';
  run("xattr", "-w", "com.simplemd.test", "preserved", file);
  run("xattr", "-w", "com.apple.metadata:_kMDItemUserTags", tag, file);
  run("chmod", "640", file);
  run("chmod", "+a", "everyone allow read", file);
  const attributes = run("xattr", "-lx", file);
  const acl = run("ls", "-le", file).split("\n").slice(1).join("\n");
  await launch("bytes-metadata", file, [
    { save: true },
    ...appendCharacter("!"),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([original, Buffer.from("!")]));
  assert.equal(run("xattr", "-lx", file), attributes, "Save dropped or changed an extended attribute or Finder tag.");
  assert.equal(run("ls", "-le", file).split("\n").slice(1).join("\n"), acl, "Save changed the ACL.");
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, "Save changed permissions.");
});

await test("settings-config-themes", async () => {
  const artifactDir = path.resolve(appRoot, "../.audit/m5c");
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = fixture("settings-config-themes/note.md", '# A quieter page\n\nA document should give its words room. SimpleMD uses the same semantic renderer for an essay, a project README and a working draft.\n\n## Read with focus\n\nThe default is warm paper and clear ink. A [useful link](https://example.com) stays underlined, and **important words** carry their own weight.\n\n> Keep the file safe, and let the reader choose the page.\n\n```typescript\nconst page = { title: "A quieter page", ready: true };\n// The source stays exactly as you wrote it.\n```\n\n| Role | Choice |\n| --- | --- |\n| Reading | Editorial |\n| Writing | System UI |\n');
  const marker = path.join(root, "settings-config-themes", "external-ready.png");
  const config = path.join(root, "settings-config-themes", "profile", "config");
  await launch("settings-config-themes", file, [
    evaluate(`await waitFor(() => document.querySelector('#doc pre.shiki span'), 'Syntax did not render.');
      await window.simplemd.setSettings({ theme: 'light' });
      window.originalHeading = document.querySelector('#doc h1');
      window.originalCode = document.querySelector('#doc pre');
      window.originalChrome = getComputedStyle(document.querySelector('.titlebar')).color;
      assert(!document.querySelector('#preferences') && !document.querySelector('#preferences-btn'), 'In-document Preferences remains.');
      await waitFor(() => getComputedStyle(document.querySelector('#stage')).backgroundColor === 'rgb(251, 247, 238)', 'Editorial Light did not apply.');`),
    { shot: path.join(artifactDir, "editorial-light.png") },
    evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ${process.platform === "darwin" ? "metaKey" : "ctrlKey"}: true, bubbles: true }));`),
    { settings: [evaluate(`await waitFor(() => document.querySelector('#reading-font-family option')?.textContent, 'Settings did not list fonts.', 20000);
      assert(typeof window.simplemd === 'undefined' && typeof require === 'undefined', 'Settings has document or Node access.');
      assert(Object.keys(window.simplemdSettings).sort().join(',') === 'get,set,subscribe', 'Settings preload exposes extra APIs.');
      const snapshot = await window.simplemdSettings.get();
      assert(snapshot.fonts.length > 4 && !snapshot.fontError, 'Installed system fonts were not listed.');
      const keys = ${quote(configEntries.map(([key]) => key))};
      assert(document.querySelectorAll('select,input').length === keys.length && keys.every(key => document.getElementById(key)?.matches('select,input')), 'Schema controls are missing.');
      const motion = document.querySelector('#ui-motion');
      assert(motion.type === 'checkbox' && motion.checked, 'Motion switch is missing or off by default');
      motion.click();
      await waitFor(() => !motion.disabled, 'Motion switch did not save');
      assert((await window.simplemdSettings.get()).settings.uiMotion === 'off', 'Motion switch did not disable motion');
      motion.click();
      await waitFor(() => !motion.disabled, 'Motion switch did not restore');
      assert((await window.simplemdSettings.get()).settings.uiMotion === 'subtle', 'Motion switch did not enable motion');
      const choose = async (key, value) => {
        const input = document.getElementById(key); input.value = value; input.dispatchEvent(new Event('change', {bubbles:true}));
        await waitFor(() => !input.disabled, 'Settings did not save.');
        assert(document.querySelector('#save-error').hidden, 'Settings write failed.');
      };
      await choose('appearance', 'dark');
      await choose('theme-dark', 'solarized-dark');`),
      { shot: path.join(artifactDir, "settings.png") },
    ] },
    evaluate(`await waitFor(() => getComputedStyle(document.querySelector('#stage')).backgroundColor === 'rgb(0, 43, 54)', 'Settings theme did not reach the document.');
      assert(document.querySelector('#doc h1') === window.originalHeading && document.querySelector('#doc pre') === window.originalCode, 'Theme change reparsed the document.');
      assert(getComputedStyle(document.querySelector('.titlebar')).color !== getComputedStyle(document.querySelector('#doc')).color, 'Document theme leaked into chrome.');
      assert(getComputedStyle(document.querySelector('#doc pre span')).color !== 'rgb(0, 0, 0)', 'Syntax did not receive theme colors.');`),
    { shot: path.join(artifactDir, "solarized-dark.png") },
    { settings: [evaluate(`document.querySelector('#reading-style').click();
      await waitFor(() => !document.querySelector('#reading-style').disabled, 'GitHub style did not save.');`)] },
    evaluate(`await waitFor(() => document.documentElement.dataset.readingStyle === 'github', 'GitHub style did not reach the document.');
      const prose = getComputedStyle(document.querySelector('#doc'));
      assert(prose.fontSize === '16px' && prose.maxWidth === '980px', 'GitHub typography differs.');
      assert(getComputedStyle(document.querySelector('#doc h1')).borderBottomStyle === 'solid', 'GitHub heading has no rule.');
      assert(document.querySelector('#doc h1') === window.originalHeading, 'Reading style replaced semantic content.');`),
    { shot: marker },
    evaluate(`await waitFor(() => getComputedStyle(document.querySelector('#stage')).backgroundColor === 'rgb(255, 255, 255)' && getComputedStyle(document.querySelector('#doc')).fontSize === '21px', 'External config did not reload.');
      assert(document.documentElement.dataset.readingStyle === 'editorial', 'External reading style did not reload.');`),
    { shot: path.join(artifactDir, "github-light.png") },
    { settings: [evaluate(`await waitFor(() => document.querySelector('#config-errors').textContent.includes('future-setting'), 'Unknown config key was not reported.');
      assert(document.querySelector('#appearance').value === 'light', 'Settings did not follow external appearance.');
      assert(document.querySelector('#reading-font-size').value === '21', 'Settings did not follow external typography.');
      const snapshot = await window.simplemdSettings.get();
      assert(snapshot.issues.some(issue => issue.key === 'autosave'), 'Invalid config value was not reported.');
      await window.simplemdSettings.set({ vim: true });`)] },
  ], "read", { marker, file: config, text: '# External edit\nappearance = light\ntheme-light = github-light\nreading-style = editorial\nreading-font-size = 21\nfuture-setting = keep\nautosave = maybe\n' });
  const stored = fs.readFileSync(config, "utf8");
  assert(stored.includes('future-setting = keep') && stored.includes('autosave = maybe'), 'Settings dropped unknown or invalid lines.');
});

await test("settings-tabs-panes", async () => {
  const shots = path.resolve(appRoot, "../.audit/m5-merge");
  fs.mkdirSync(shots, { recursive: true });
  const text = '# A quieter page\n\nSimpleMD keeps the file safe while each pane keeps its own view.\n\n## Read and write\n\nA [useful link](https://example.com) and **clear words**.\n\n```typescript\nconst page = { ready: true };\n```\n';
  const a = fixture("settings-tabs-panes/reading.md", text);
  const b = fixture("settings-tabs-panes/writing.md", text.replace('A quieter page', 'Working draft'));
  const c = fixture("settings-tabs-panes/later.md", text.replace('A quieter page', 'Another page'));
  await launch("settings-tabs-panes", a, [
    evaluate(`await window.simplemd.openPath(${quote(b)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Writing tab did not mount.');
      window.writingId = Number(document.documentElement.dataset.documentId);
      window.simplemd.command('split-panes');
      await waitFor(() => document.querySelectorAll('.document-pane').length === 2, 'Two panes did not mount.');
      window.simplemd.command('mode-split');
      await waitFor(() => document.querySelector('[data-element="preview"] pre'), 'Preview did not render.');
      await window.simplemd.setSettings({ theme: 'light', themeLight: 'editorial-light' });
      await waitFor(() => [...document.querySelectorAll('.document-pane')].every(p => getComputedStyle(p).backgroundColor === 'rgb(251, 247, 238)'), 'Light theme missed a pane.');
      window.semanticHeadings = [...document.querySelectorAll('.document-pane .prose h1')];
      assert(!document.body.textContent.includes('Preferences'), 'Old Preferences text returned.');`),
    { shot: path.join(shots, "editorial-light.png") },
    evaluate(`await window.simplemd.setSettings({ theme: 'dark', themeDark: 'editorial-dark' });
      await waitFor(() => [...document.querySelectorAll('.document-pane')].every(p => getComputedStyle(p).backgroundColor === 'rgb(10, 18, 25)'), 'Dark theme missed a pane.');
      assert(window.semanticHeadings.every(h => h.isConnected), 'Theme replaced document nodes.');`),
    { shot: path.join(shots, "editorial-dark.png") },
    evaluate(`await window.simplemd.setSettings({ readingStyle: 'github', writingFontFamily: 'Georgia', writingFontSize: 20, codeFontFamily: 'Menlo', codeFontSize: 15 });
      await waitFor(() => [...document.querySelectorAll('.document-pane .prose')].every(p => getComputedStyle(p).fontSize === '16px'), 'GitHub style missed a pane.');
      assert(window.semanticHeadings.every(h => h.isConnected), 'Reading style replaced document nodes.');
      const editor = document.querySelector('.cm-content');
      assert(getComputedStyle(editor).fontSize === '20px' && getComputedStyle(editor).fontFamily.includes('Georgia'), 'Writing typography did not apply.');
      assert([...document.querySelectorAll('.prose pre code')].every(c => getComputedStyle(c).fontSize === '15px' && getComputedStyle(c).fontFamily.includes('Menlo')), 'Code typography missed a pane.');
      const reading = [...document.querySelectorAll('.document-pane')].find(p => p.querySelector('[data-element="read"]').hidden === false);
      assert(reading, 'Reading pane disappeared.');
      await window.simplemd.focusPane(Number(reading.dataset.paneId));
      reading.querySelector('[data-element="edit-btn"]').click();
      await waitFor(() => document.querySelectorAll('.cm-editor').length === 2, 'Reading pane did not enter edit mode.');
      window.simplemd.command('mode-live');
      await window.simplemd.setSettings({ readingStyle: 'editorial', readingFontFamily: 'Georgia', readingFontSize: 22 });
      await waitFor(() => [...document.querySelectorAll('.prose')].every(p => getComputedStyle(p).fontSize === '22px'), 'Reading typography missed a pane.');
      const modes = [...document.querySelectorAll('[data-element="edit"]')].map(p => p.dataset.mode);
      assert(modes.includes('live') && modes.includes('split'), 'Reading style changed independent modes.');
      await window.simplemd.openPath(${quote(c)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(c)}, 'Third tab did not mount.');
      window.simplemd.command('split-panes');
      await waitFor(() => document.querySelectorAll('.document-pane').length === 1, 'Panes did not collapse.');
      await window.simplemd.setSettings({ writingFontSize: 23, themeDark: 'solarized-dark' });
      await window.simplemd.activateTab(window.writingId);
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Dormant tab did not remount.');
      assert(getComputedStyle(document.querySelector('.document-pane')).backgroundColor === 'rgb(0, 43, 54)', 'Remounted tab missed the theme.');
      assert(getComputedStyle(document.querySelector('.cm-content')).fontSize === '23px', 'Remounted tab missed typography.');
      assert(document.querySelectorAll('.cm-editor').length === 1, 'Inactive editor remained mounted.');`),
  ]);
  for (const file of [a, b, c]) assert.equal(fs.readFileSync(file, "utf8"), file === b ? text.replace('A quieter page', 'Working draft') : file === c ? text.replace('A quieter page', 'Another page') : text);
});

await test("tabs-clean-payload", async () => {
  const a = fixture("tabs-payload/a.md", note), b = fixture("tabs-payload/b.md", "# Clean payload\n");
  await launch("tabs-clean-payload", a, [evaluate(`window.simplemd.onDoc(payload => { window.lastPayload = payload; });
    await window.simplemd.openPath(${quote(b)}, 'edit');
    assert(window.lastPayload.text === ${quote("# Clean payload\n")}, 'Wrong payload text');
    assert(window.lastPayload.savedText === undefined, 'Clean document sent its source twice');`)], "edit");
});

await test("tabs-panes", async () => {
  const aText = "\uFEFF# Tab A\r\n\r\n[Sibling](b.md)\r\nTail";
  const bText = "# Tab B\n\nSecond document.\n";
  const a = fixture("tabs-panes/a.md", aText), b = fixture("tabs-panes/b.md", bText);
  const shots = path.resolve(appRoot, "../.audit/m5a");
  fs.mkdirSync(shots, { recursive: true });
  await launch("tabs-panes", a, [
    ...appendCharacter("!"),
    evaluate(`window.tabA = Number(document.documentElement.dataset.documentId);
      await window.simplemd.openPath(${quote(b)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Second tab did not mount.');
      window.tabB = Number(document.documentElement.dataset.documentId);
      assert(document.querySelectorAll('[role="tab"]').length === 2, 'Missing tabs.');
      assert(document.querySelectorAll('.cm-editor').length === 1, 'Inactive editor stayed mounted.');
      await window.simplemd.openPath(${quote(a)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Existing tab did not focus.');
      assert(document.querySelectorAll('[role="tab"]').length === 2, 'Existing open duplicated a tab.');
      assert(document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().endsWith('Tail!'), 'Unsaved text lost.');
      window.simplemd.command('undo');
      await waitFor(() => !document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().endsWith('!'), 'Undo lost across remount.');
      window.simplemd.command('redo');
      await waitFor(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().endsWith('!'), 'Redo lost across remount.');`),
    { shot: path.join(shots, "one-pane.png") },
    { save: true },
    evaluate(`window.simplemd.command('split-panes');
      await waitFor(() => document.querySelectorAll('.cm-editor').length === 2, 'Two panes did not mount.');
      const all = [...document.querySelectorAll('.document-pane')];
      assert(all.every(p => p.getBoundingClientRect().width > 200), 'Pane has no visible width.');
      window.simplemd.command('mode-live');
      await window.simplemd.focusPane(Number(all[1].dataset.paneId));
      window.simplemd.command('mode-split');
      await waitFor(() => all[1].querySelector('[data-element="edit"]').dataset.mode === 'split', 'Second mode did not change.').catch(error => { throw new Error(error.message + JSON.stringify(all.map(p => ({ active: p.dataset.active, pane: p.dataset.paneId, id: p.dataset.documentId, mode: p.querySelector('[data-element=edit]').dataset.mode })))); });
      assert(all[0].querySelector('[data-element="edit"]').dataset.mode === 'live', 'Mode leaked between panes.');
      all[0].querySelector('[data-element="editor-host"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await waitFor(() => all[0].dataset.active === 'true', 'Click did not focus first pane.');`),
    { windowCount: 1 },
    { shot: path.join(shots, "two-panes.png") },
    evaluate(`window.simplemd.command('stack-panes');
      await waitFor(() => document.querySelector('#stage').dataset.axis === 'vertical', 'Stack layout did not apply.');
      const all = [...document.querySelectorAll('.document-pane')];
      assert(all[1].getBoundingClientRect().top > all[0].getBoundingClientRect().top, 'Panes did not stack.');`),
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(aText + "!"), "Tab remount or undo changed untouched bytes.");
  assert.deepEqual(fs.readFileSync(b), Buffer.from(bText), "Other pane changed saved bytes.");
});

for (const response of [0, 1] as const) await test(`tabs-dirty-close-${response === 0 ? "save" : "discard"}`, async () => {
  const a = fixture(`tabs-close-${response}/a.md`, note), b = fixture(`tabs-close-${response}/b.md`, "# Other\n");
  await launch(`tabs-close-${response}`, a, [
    ...appendCharacter("!"),
    evaluate(`window.closeId = Number(document.documentElement.dataset.documentId); await window.simplemd.openPath(${quote(b)}, 'edit');`),
    { dialog: { response } },
    evaluate(`assert(await window.simplemd.closeTab(window.closeId), 'Dirty close failed.');
      await waitFor(() => document.querySelectorAll('[role="tab"]').length === 1, 'Closed tab remains.');
      assert(document.querySelector('#tabs').hidden, 'Single tab strip stayed visible.');`),
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(note + (response === 0 ? "!" : "")));
});

await test("tabs-autosave-dormant", async () => {
  const a = fixture("tabs-autosave/a.md", note), b = fixture("tabs-autosave/b.md", "# Other\n");
  await launch("tabs-autosave-dormant", a, [
    evaluate(`await window.simplemd.setSettings({ autosave: true }); window.autosaveId = Number(document.documentElement.dataset.documentId);`),
    ...appendCharacter("!"),
    evaluate(`await window.simplemd.openPath(${quote(b)}, 'edit');`),
    { wait: 1100 },
    evaluate(`await window.simplemd.activateTab(window.autosaveId); await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Autosaved tab did not mount');
      assert(document.querySelector('#dirty').hidden, 'Dormant tab did not autosave');`),
  ], "edit");
  assert.equal(fs.readFileSync(a, "utf8"), note + "!");
});
await test("tabs-autosave-close", async () => {
  const a = fixture("tabs-autosave-close/a.md", note);
  await launch("tabs-autosave-close", a, [
    { noSavePrompt: true }, evaluate(`await window.simplemd.setSettings({ autosave: true });`),
    ...appendCharacter("!"),
    evaluate(`assert(await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId)), 'Autosave close refused');`),
    { visibility: false },
  ], "edit");
  assert.equal(fs.readFileSync(a, "utf8"), note + "!");
});

await test("tabs-render-in-flight", async () => {
  const source = "\uFEFF# Render A\r\n\r\n" + "```ts\r\nconst n = 1;\r\n```\r\n".repeat(200);
  const a = fixture("tabs-render/a.md", source), b = fixture("tabs-render/b.md", "# Render B\n");
  await launch("tabs-render", a, [
    ...appendCharacter("!"),
    evaluate(`window.renderA = Number(document.documentElement.dataset.documentId);
      const revision = Number(document.documentElement.dataset.revisionId);
      window.lateRender = window.simplemd.renderBlocks(${quote(source + "!")}, window.renderA, revision).then(result => result, error => String(error));
      await window.simplemd.openPath(${quote(b)}, 'edit');
      await window.lateRender;
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'B did not mount.');
      assert(document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === '# Render B\\n', 'Late A render replaced B.');
      await window.simplemd.activateTab(window.renderA);
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'A did not remount.');`),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(source + "!"));
  assert.deepEqual(fs.readFileSync(b), Buffer.from("# Render B\n"));
});

await test("tabs-inactive-pane-link", async () => {
  const a = fixture("tabs-inactive-link/a.md", "# A\n\n[Sibling](c.md)\n");
  const b = fixture("tabs-inactive-link/b.md", "# B\n");
  const c = fixture("tabs-inactive-link/c.md", "# C\n");
  await launch("tabs-inactive-pane-link", a, [evaluate(`
    window.linkA = Number(document.documentElement.dataset.documentId);
    await window.simplemd.openPath(${quote(b)}, 'read');
    await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Second tab did not become readable');
    window.linkB = Number(document.documentElement.dataset.documentId);
    window.simplemd.command('split-panes');
    await waitFor(() => document.querySelectorAll('.document-pane').length === 2, 'Split did not mount');
    await window.simplemd.activateTab(window.linkB);
    await waitFor(() => [...document.querySelectorAll('.document-pane')].some(p => Number(p.dataset.documentId) === window.linkA && p.querySelector('a')), 'Sibling pane did not become readable');
    const clicked = [...document.querySelectorAll('.document-pane')].find(p => Number(p.dataset.documentId) === window.linkA);
    clicked.querySelector('a').click();
    await waitFor(() => [...document.querySelectorAll('.document-pane')].some(p => p.dataset.documentPath === ${quote(c)}), 'Clicked pane did not navigate');
    assert([...document.querySelectorAll('.document-pane')].some(p => p.dataset.documentPath === ${quote(b)}), 'Link replaced the active pane');
    assert(![...document.querySelectorAll('.document-pane')].some(p => p.dataset.documentPath === ${quote(a)}), 'Clicked pane was not replaced');
  `)], "read");
});

await test("tabs-diagram-revisit", async () => {
  const source = "# Diagrams\n\n" + Array.from({ length: 8 }, (_, i) => `\`\`\`mermaid\ngraph LR\nA${i}[Start]-->B${i}[Finish]\n\`\`\`\n\n`).join("");
  const a = fixture("diagram-revisit/a.md", source), b = fixture("diagram-revisit/b.md", "# Other\n");
  await launch("tabs-diagram-revisit", a, [
    assertPerfDocument(a, source),
    ...Array.from({ length: 4 }, () => [
      evaluate(`await window.simplemd.openPath(${quote(b)}, 'read');`),
      assertPerfDocument(b, "# Other\n"),
      evaluate(`await window.simplemd.openPath(${quote(a)}, 'read');`),
      assertPerfDocument(a, source),
    ]).flat(),
  ]);
});

await test("tab-design-polish-search-layout", async () => {
  const shots = path.resolve(appRoot, "../.audit/m6-stabilize/screenshots");
  fs.mkdirSync(shots, { recursive: true });
  const file = fixture("tab-polish/README.md", "# A quiet place to read\n\nKeep the document at the center.\n\n## Room for the work\n\nOpen a few notes and keep your place.\n");
  const draft = fixture("tab-polish/Working draft.md", "# Working draft\n\nA small set of familiar controls and room for the work.\n");
  await launch("tab-design-polish-search-layout", file, [
    { nativeMenu: ["View", "Pin Tab"] },
    evaluate(`await window.simplemd.openPath(${quote(draft)}, 'edit');`),
    ...appendCharacter("!"),
    evaluate(`window.simplemd.command('mode-read');
      await waitFor(() => document.querySelector('.document-pane').dataset.view === 'read' && document.querySelector('#doc h1'), 'Read did not mount');
      await window.simplemd.setSettings({ theme: 'light' });
      await waitFor(() => document.documentElement.style.colorScheme === 'light', 'Light theme did not apply');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const toolbar = document.querySelector('.document-pane[data-active=true] .pane-controls');
      assert(toolbar.getBoundingClientRect().top === 3, 'Toolbar is not in the title row');
      assert(document.querySelector('#tabs').getBoundingClientRect().right + 27 <= toolbar.getBoundingClientRect().left, 'Tabs overlap the toolbar or grab space');
      assert(getComputedStyle(document.querySelector('[data-element=name]')).display === 'none', 'Single pane repeats the filename');
      assert([...toolbar.querySelectorAll('[data-mode]')].every(button => button.querySelector('svg') && button.getAttribute('aria-label') && button.title), 'Mode icons lack names or tooltips');
      assert(toolbar.querySelector('[data-mode=read]').getAttribute('aria-pressed') === 'true', 'Read icon is not pressed');
      assert(document.querySelector('.tab[data-pinned=true] .tab-short').textContent === 'R', 'Pinned tab is not compact');
      const name = document.querySelector('.tab[data-dirty=true] .tab-name').getBoundingClientRect();
      const slot = document.querySelector('.tab[data-dirty=true] .tab-action').getBoundingClientRect();
      assert(slot.left - name.right <= 6.1, 'Dirty slot is detached from its label');`),
    { input: { type: "mouseMove", x: 500, y: 300 } },
    { shot: path.join(shots, "after-top-light.png") },
    evaluate(`document.querySelector('#tab-search-button').click();
      await waitFor(() => !document.querySelector('#picker').hidden, 'Search button did not open Open Quickly');`),
    { input: { type: "keyDown", keyCode: "Escape" } }, { input: { type: "keyUp", keyCode: "Escape" } },
    evaluate(`await waitFor(() => document.querySelector('#picker').hidden, 'Search picker did not close');
      await window.simplemd.setSettings({ theme: 'dark' });
      await waitFor(() => document.documentElement.style.colorScheme === 'dark', 'Dark theme did not apply');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`),
    { shot: path.join(shots, "after-top-dark.png") },
    evaluate(`await window.simplemd.setSettings({ tabStyle: 'sidebar' });
      await waitFor(() => document.querySelector('#tabs').getBoundingClientRect().width === 180, 'Sidebar did not use its slim default');
      assert(document.querySelector('#tabs').getBoundingClientRect().top === 0, 'Sidebar does not reach the window top');
      assert(document.querySelector('#sidebar-search').getBoundingClientRect().top >= 34, 'Search overlaps traffic lights');
      assert(document.querySelector('.document-pane[data-active=true] .pane-controls').getBoundingClientRect().top === 3, 'Sidebar moved controls to a second row');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`),
    { shot: path.join(shots, "after-sidebar-dark.png") },
    evaluate(`const search = document.querySelector('#sidebar-search-input');
      search.value = 'Working'; search.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(() => !document.querySelector('#picker').hidden && document.querySelector('#picker-input').value === 'Working', 'Sidebar search lost the query');`),
    { input: { type: "keyDown", keyCode: "Escape" } }, { input: { type: "keyUp", keyCode: "Escape" } },
    evaluate(`await waitFor(() => document.querySelector('#picker').hidden, 'Sidebar search picker did not close');
      await window.simplemd.setSettings({ theme: 'light' });
      await waitFor(() => document.documentElement.style.colorScheme === 'light', 'Sidebar light theme did not apply');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`),
    { shot: path.join(shots, "after-sidebar-light.png") },
    evaluate(`document.querySelector('.document-pane[data-active=true] [data-command=split-panes]').click();
      await waitFor(() => document.querySelectorAll('.document-pane').length === 2, 'Split icon did not open another pane');
      assert(document.querySelectorAll('.pane-name [data-element=name]').length === 2, 'Split headers lost filenames');
      assert(document.querySelector('.document-pane[data-active=true] [data-command=split-panes]').getAttribute('aria-pressed') === 'true', 'Split icon is not pressed');
      document.querySelector('.document-pane[data-active=true] [data-command=stack-panes]').click();
      await waitFor(() => document.querySelector('#stage').dataset.axis === 'vertical', 'Stacked icon did not change the layout');
      await window.simplemd.setSettings({ zenMode: true });
      assert(getComputedStyle(document.querySelector('#tab-search')).display === 'none', 'Zen retained search');`),
  ]);
});

await test("tab-design-titlebar-grab-regions", async () => {
  const file = fixture("tab-design-titlebar/README.md", note), other = fixture("tab-design-titlebar/other.md", "# Other\n");
  await launch("tab-design-titlebar-grab-regions", file, [
    evaluate(`await window.simplemd.openPath(${quote(other)}); await waitFor(() => document.querySelectorAll('[role=tab]').length === 2, 'Second tab did not appear');
      const tabs = document.querySelector('#tabs'), titlebar = document.querySelector('.titlebar');
      assert(getComputedStyle(tabs).getPropertyValue('-webkit-app-region') === 'drag', 'Empty strip does not drag');
      assert(getComputedStyle(titlebar).getPropertyValue('-webkit-app-region') === 'drag', 'Titlebar does not drag');
      assert(getComputedStyle(tabs.firstElementChild).getPropertyValue('-webkit-app-region') === 'no-drag', 'Tabs cannot receive clicks');
      assert(innerWidth - tabs.getBoundingClientRect().right >= 27, 'Overflow removed the frame grab space');`),
    { nativeChrome: true },
    { nativeIdentity: { file: other, edited: false } },
    evaluate(`await window.simplemd.setSettings({ tabStyle: 'sidebar' });`),
    { nativeChrome: true },
  ]);
});

await test("tab-design-zen-native-toggle", async () => {
  const file = fixture("tab-design-zen/README.md", note);
  await launch("tab-design-zen-native-toggle", file, [
    { nativeMenu: ["View", "Zen Mode"] },
    evaluate(`await waitFor(() => document.body.dataset.zen === 'true', 'Zen menu did not apply');
      assert(getComputedStyle(document.querySelector('.pane-status')).display === 'none', 'Zen retained footer');
      assert(document.querySelector('#stage').getBoundingClientRect().top === 0, 'Zen retained titlebar space');`),
    { nativeIdentity: { file, edited: false } },
    { input: { type: "mouseMove", x: 200, y: 2 } },
    evaluate(`await waitFor(() => document.body.dataset.chromeRevealed === 'true', 'Top edge did not reveal controls');`),
    { input: { type: "keyDown", keyCode: "J", modifiers: [mod, "shift"] } },
    { input: { type: "keyUp", keyCode: "J", modifiers: [mod, "shift"] } },
    evaluate(`await waitFor(() => document.body.dataset.zen === 'false', 'Zen shortcut did not exit');`),
    { nativeMenuState: { path: ["View", "Zen Mode"], enabled: true, checked: false } },
  ]);
});

await test("tabs-pinned-relaunch", async () => {
  const name = "tabs-pinned-relaunch", a = fixture(name + "/a.md", note), b = fixture(name + "/b.md", "# B\n"), c = fixture(name + "/missing.md", "# Missing\n");
  await launch(name, a, [
    { nativeMenu: ["View", "Pin Tab"] },
    evaluate(`await window.simplemd.openPath(${quote(b)});`),
    { nativeMenu: ["View", "Pin Tab"] },
    evaluate(`await window.simplemd.openPath(${quote(c)});`),
    { nativeMenu: ["View", "Pin Tab"] },
    { input: { type: "keyDown", keyCode: "W", modifiers: [mod] } },
    { input: { type: "keyUp", keyCode: "W", modifiers: [mod] } },
    evaluate(`assert(document.querySelectorAll('[role=tab]').length === 3, 'Normal close removed a pin');`),
    { menuQuit: true },
  ]);
  const state = fs.readFileSync(path.join(root, name, "profile/settings.json"), "utf8");
  assert.deepEqual(JSON.parse(state).pinnedPaths, [a, b, c]);
  fs.unlinkSync(c);
  await launch(name, "", [
    evaluate(`await waitFor(() => document.querySelectorAll('[role=tab]').length === 2, 'Existing pins did not restore');
      assert([...document.querySelectorAll('[role=tab]')].every(tab => tab.dataset.pinned === 'true'), 'Restored an ordinary tab');
      assert([...document.querySelectorAll('[role=tab]')].map(tab => tab.title).join('|') === ${quote(a + "|" + b)}, 'Pin order changed');`),
    { nativeMenu: ["View", "Close Pinned Tab"] },
    evaluate(`await waitFor(() => document.querySelectorAll('[role=tab]').length === 1, 'Explicit close retained the pin');`),
  ], "read", undefined, 0, "source", { prepare: profile => fs.writeFileSync(path.join(profile, "settings.json"), state) });
});

await test("tab-sidebar-menu-resize-relaunch", async () => {
  const name = "tab-sidebar-menu-resize-relaunch";
  const file = fixture(`${name}/README.md`, note);
  const modifiers: ("control" | "meta" | "alt")[] = process.platform === "darwin" ? ["control", "meta"] : ["control", "alt"];
  await launch(name, file, [
    { nativeMenuState: { path: ["View", "Show Tab Sidebar"], enabled: true } },
    { nativeMenu: ["View", "Show Tab Sidebar"] },
    evaluate(`await waitFor(() => document.body.dataset.tabStyle === 'sidebar' && !document.querySelector('#tabs').hidden, 'View did not show the sidebar');
      assert(document.querySelectorAll('[role=tab]').length === 1, 'Sidebar omitted its only document');
      assert(document.querySelector('#tabs').getAttribute('aria-orientation') === 'vertical', 'Sidebar is not vertical');`),
    { nativeIdentity: { file, edited: false } },
    { input: { type: "keyDown", keyCode: "S", modifiers } },
    { input: { type: "keyUp", keyCode: "S", modifiers } },
    evaluate(`await waitFor(() => document.querySelector('#tabs').hidden, 'Sidebar shortcut did not collapse');
      assert(Math.abs(document.querySelector('#stage').getBoundingClientRect().width - innerWidth) < 1, 'Collapsed sidebar retains width');
      assert(document.querySelector('.tb-title').getBoundingClientRect().width > 30, 'Collapsed sidebar lost the visible filename');`),
    { nativeMenuState: { path: ["View", "Show Tab Sidebar"], enabled: true } },
    { nativeMenu: ["View", "Show Tab Sidebar"] },
    evaluate(`await waitFor(() => !document.querySelector('#sidebar-divider').hidden, 'Sidebar did not reopen');
      window.resizeEvents = [];
      for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','dblclick']) document.querySelector('#sidebar-divider').addEventListener(type, event => window.resizeEvents.push([type, event.clientX, event.pointerId, event.buttons, document.querySelector('#sidebar-divider').getAttribute('aria-valuenow')]));`),
    { input: { type: "mouseDown", x: 182, y: 110, button: "left", clickCount: 1 } },
    { input: { type: "mouseMove", x: 302, y: 110, button: "left", modifiers: ["leftbuttondown"] } },
    evaluate(`assert((await window.simplemd.ready()).settings.sidebarWidth === 180, 'Drag wrote config before release');`),
    { input: { type: "mouseUp", x: 302, y: 110, button: "left", clickCount: 1 } },
    evaluate(`await waitFor(() => document.querySelector('#sidebar-divider').getAttribute('aria-valuenow') === '300', 'Native divider drag failed');
      const deadline = performance.now() + 10000;
      while ((await window.simplemd.ready()).settings.sidebarWidth !== 300) {
        assert(performance.now() < deadline, 'Drag width did not persist: ' + JSON.stringify({ settings: (await window.simplemd.ready()).settings.sidebarWidth, events: window.resizeEvents }));
        await new Promise(resolve => setTimeout(resolve, 25));
      }`),
    { input: { type: "mouseDown", x: 302, y: 110, button: "left", clickCount: 2 } },
    { input: { type: "mouseUp", x: 302, y: 110, button: "left", clickCount: 2 } },
    evaluate(`await waitFor(() => document.querySelector('#sidebar-divider').getAttribute('aria-valuenow') === '180', 'Double click did not reset divider');`),
    { input: { type: "mouseDown", x: 182, y: 110, button: "left", clickCount: 1 } },
    { input: { type: "mouseMove", x: 302, y: 110, button: "left", modifiers: ["leftbuttondown"] } },
    { input: { type: "mouseUp", x: 302, y: 110, button: "left", clickCount: 1 } },
    evaluate(`await waitFor(() => document.querySelector('#sidebar-divider').getAttribute('aria-valuenow') === '300', 'Final width did not apply');`),
    { debug: { method: "Emulation.setEmulatedMedia", params: { features: [{ name: "forced-colors", value: "active" }] } } },
    evaluate(`const selected = getComputedStyle(document.querySelector('[role=tab][aria-selected=true]'));
      assert(selected.outlineWidth === '2px' && selected.outlineStyle === 'solid', 'Sidebar selection has no forced-colors cue');`),
    { nativeMenu: ["View", "Hide Tab Sidebar"] },
    evaluate(`await waitFor(() => document.querySelector('#tabs').hidden, 'Menu did not hide sidebar');`),
    { menuQuit: true },
  ]);
  const config = path.join(root, name, "profile", "config");
  assert(/sidebar-width = 300/.test(fs.readFileSync(config, "utf8")), "Sidebar width was not written to config.");
  assert(/sidebar-collapsed = true/.test(fs.readFileSync(config, "utf8")), "Sidebar collapse was not written to config.");
  await launch(name, file, [
    evaluate(`const settings = (await window.simplemd.ready()).settings;
      assert(settings.tabStyle === 'sidebar' && settings.sidebarWidth === 300 && settings.sidebarCollapsed, 'Sidebar settings did not survive relaunch');
      assert(document.querySelector('#tabs').hidden && document.querySelector('#sidebar-divider').hidden, 'Relaunch lost collapsed state');`),
    { input: { type: "keyDown", keyCode: "S", modifiers } },
    { input: { type: "keyUp", keyCode: "S", modifiers } },
    evaluate(`await waitFor(() => !document.querySelector('#tabs').hidden, 'Shortcut did not reopen after relaunch');
      assert(document.querySelector('#sidebar-divider').getAttribute('aria-valuenow') === '300', 'Reopened sidebar lost width');`),
    { nativeIdentity: { file, edited: false } },
  ]);
});

await test("tab-sidebar-edited-identity", async () => {
  const file = fixture("tab-sidebar-edited/README.md", note);
  await launch("tab-sidebar-edited-identity", file, [
    evaluate(`await window.simplemd.setSettings({ tabStyle: 'sidebar' });`),
    ...appendCharacter("!"),
    { nativeIdentity: { file, edited: true } },
    evaluate(`await waitFor(() => document.querySelector('[role=tab]').dataset.dirty === 'true', 'Sidebar did not show dirty state');
      await window.simplemd.setSettings({ tabStyle: 'top' });
      await window.simplemd.setSettings({ tabStyle: 'sidebar' });
      assert(!document.querySelector('#dirty').hidden && document.title === 'README.md', 'Tab style changed Edited or title state');`),
    { nativeIdentity: { file, edited: true } },
    { dialog: { response: 1 } }, { menuQuit: true },
  ], "edit");
  assert.equal(fs.readFileSync(file, "utf8"), note, "Changing tab style saved the unsaved edit.");
});

await test("tab-sidebar-native-actions-and-live-windows", async () => {
  const a = fixture("tab-sidebar-actions/one/README.md", note), b = fixture("tab-sidebar-actions/two/README.md", "# Other\n");
  const c = fixture("tab-sidebar-actions/third.md", "# Third\n");
  const context = { selectionPresent: false, editable: false, linkURL: "", imageURL: "", misspelledWord: "", suggestions: [] };
  await launch("tab-sidebar-native-actions-and-live-windows", a, [
    evaluate(`await window.simplemd.openPath(${quote(b)}); window.simplemd.command('move-tab-window');`),
    { windowCount: 2 }, { selectWindow: a },
    evaluate(`await window.simplemd.setSettings({ tabStyle: 'sidebar', sidebarWidth: 280 });
      await waitFor(() => !document.querySelector('#tabs').hidden, 'First window missed sidebar style');`),
    { selectWindow: b },
    evaluate(`await waitFor(() => !document.querySelector('#tabs').hidden, 'Second window missed live sidebar style');
      assert(document.querySelector('#sidebar-divider').getAttribute('aria-valuenow') === '280', 'Second window missed live width');
      await window.simplemd.openPath(${quote(c)});
      await waitFor(() => document.querySelectorAll('[role=tab]').length === 2, 'Second tab did not appear');`),
    { nativeContext: { selector: "#tabs .tab:first-child", context, labels: ["Close Tab", "Move Tab to New Window", process.platform === "darwin" ? "Reveal in Finder" : "Show in File Manager"], choose: "Close Tab" } },
    evaluate(`await waitFor(() => document.querySelectorAll('[role=tab]').length === 1, 'Sidebar context Close Tab failed');
      assert(document.documentElement.dataset.documentPath === ${quote(c)}, 'Context close changed the active document');
      await window.simplemd.setSettings({ sidebarCollapsed: true });`),
    { selectWindow: a },
    evaluate(`await waitFor(() => document.querySelector('#tabs').hidden, 'Collapse did not apply to every window');
      await window.simplemd.setSettings({ tabStyle: 'top' });`),
    { selectWindow: c },
    evaluate(`await waitFor(() => document.querySelector('#tabs').getAttribute('aria-orientation') === 'horizontal', 'Top style did not apply to every window');
      await window.simplemd.setSettings({ tabStyle: 'sidebar', sidebarCollapsed: false });
      await window.simplemd.openPath(${quote(b)});
      await waitFor(() => document.querySelectorAll('[role=tab]').length === 2, 'Middle click fixture did not open');`),
    { input: { type: "mouseDown", x: 80, y: 88, button: "middle", clickCount: 1 } },
    { input: { type: "mouseUp", x: 80, y: 88, button: "middle", clickCount: 1 } },
    evaluate(`await waitFor(() => document.querySelectorAll('[role=tab]').length === 1, 'Native middle click did not close sidebar row');`),
  ]);
});

await test("tabs-keyboard-focus", async () => {
  const a = fixture("tabs-focus/a.md", note), b = fixture("tabs-focus/b.md", "# B\n"), c = fixture("tabs-focus/c.md", "# C\n");
  await launch("tabs-keyboard-focus", a, [
    evaluate(`await window.simplemd.openPath(${quote(b)}, 'edit'); await window.simplemd.openPath(${quote(c)}, 'edit');
      window.originalTabNodes = [...document.querySelectorAll('[role=tab]')];
      document.querySelector('[role=tab][aria-selected=true]').focus();`),
    { input: { type: "keyDown", keyCode: "Left" } }, { input: { type: "keyUp", keyCode: "Left" } },
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Arrow did not switch tab');
      await new Promise(r => setTimeout(r, 100));
      assert(document.activeElement.matches('[role=tab][aria-selected=true]'), 'Arrow moved focus out of the tablist');
      assert(window.originalTabNodes.every(tab => tab.isConnected), 'Tab update replaced nodes');`),
    { input: { type: "keyDown", keyCode: "Home" } }, { input: { type: "keyUp", keyCode: "Home" } },
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Home did not select first tab'); assert(document.activeElement.matches('[role=tab]'), 'Home lost focus');`),
    { input: { type: "keyDown", keyCode: "End" } }, { input: { type: "keyUp", keyCode: "End" } },
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(c)}, 'End did not select last tab'); assert(document.activeElement.matches('[role=tab]'), 'End lost focus');`),
    evaluate(`assert([...document.querySelectorAll('[role=tab] button')].every(button => button.tabIndex === -1), 'Nested close buttons are focusable');`),
    { debug: { method: "Emulation.setEmulatedMedia", params: { features: [{ name: "forced-colors", value: "active" }] } } },
    evaluate(`const style = getComputedStyle(document.querySelector('[role=tab][aria-selected=true]')); assert(style.outlineWidth === '2px' && style.outlineStyle === 'solid', 'Selected tab has no forced-colors outline');`),
    { input: { type: "keyDown", keyCode: "Delete" } }, { input: { type: "keyUp", keyCode: "Delete" } },
    evaluate(`await waitFor(() => document.querySelectorAll('[role=tab]').length === 2, 'Delete did not close the focused tab');`),
  ], "edit");
});

await test("tabs-sibling-command-click", async () => {
  const a = fixture("tabs-links/a.md", "# Link A\n\n[Sibling](b.md)\n"), b = fixture("tabs-links/b.md", "# Link B\n");
  await launch("tabs-links", a, [
    evaluate(`document.querySelector('#doc a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ${process.platform === "darwin" ? "metaKey" : "ctrlKey"}: true }));
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Modified click did not open sibling.');
      assert(document.querySelectorAll('[role="tab"]').length === 2, 'Modified click replaced current tab.');
      await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId));
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Link origin did not return.');
      document.querySelector('#doc a').click();
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Plain click did not navigate.');
      assert(document.querySelectorAll('[role="tab"]').length === 1, 'Plain click created another tab.');
      window.simplemd.command('nav-back');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Back did not navigate.');
      window.simplemd.command('nav-forward');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Forward did not navigate.');`),
  ]);
});

await test("tabs-windows", async () => {
  const a = fixture("tabs-windows/a.md", note), b = fixture("tabs-windows/b.md", "# Separate window\n");
  const c = fixture("tabs-windows/c.md", "# New tab in remaining window\n");
  await launch("tabs-windows", a, [
    ...appendCharacter("!"),
    evaluate(`window.simplemd.command('move-tab-window');`),
    { wait: 300 },
    { windowCount: 1 },
    { selectWindow: 0 },
    { save: true },
    evaluate(`await window.simplemd.openPath(${quote(a)}, 'edit');`),
    { windowCount: 1 },
    evaluate(`await window.simplemd.setSettings({ openIn: 'window' }); await window.simplemd.openPath(${quote(b)}, 'edit');`),
    { windowCount: 2 },
    { selectWindow: b },
    evaluate(`await window.simplemd.setSettings({ openIn: 'tab' }); window.simplemd.command('close-tab');`),
    { wait: 200 },
    { windowCount: 1 },
    { selectWindow: a },
    evaluate(`await window.simplemd.openPath(${quote(c)}, 'edit');`),
    { windowCount: 1 },
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(note + "!"), "Moving a dirty tab lost unsaved bytes.");
});

await test("open-quickly-shortcut-scope-tab-pane", async () => {
  const a = fs.realpathSync(fixture("open-quickly/active.md", "# Active\n"));
  const b = fs.realpathSync(fixture("open-quickly/unique-quickly-guide.mdx", "# Guide\n"));
  const c = fs.realpathSync(fixture("open-quickly/unique-quickly-other.markdown", "# Other\n"));
  const key = (keyCode: string, modifiers: NonNullable<KeyboardInputEvent["modifiers"]> = []): Step[] => [
    { input: { type: "keyDown", keyCode, modifiers } }, { input: { type: "keyUp", keyCode, modifiers } },
  ];
  await launch("open-quickly", a, [
    ...key("O", [mod, "shift"]),
    evaluate(`await waitFor(() => !document.querySelector('#picker').hidden && document.activeElement.id === 'picker-input', 'Open Quickly shortcut failed.');
      assert(document.querySelector('.picker-scope').textContent === 'This repo', 'Initial scope differs.');`),
    ...key("Tab"),
    evaluate(`assert(document.querySelector('.picker-scope').textContent === 'Everywhere', 'Tab did not change scope.');`),
    ...key("Tab"),
    evaluate(`const input = document.querySelector('#picker-input'); input.value = 'unique-quickly-guide'; input.dispatchEvent(new Event('input'));
      await waitFor(() => [...document.querySelectorAll('#picker-list [role=option]')].some(row => row.title === ${quote(b)}), 'Folder result missing.');`),
    ...key("Enter"),
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Result did not open.');
      assert(document.querySelectorAll('[role=tab]').length === 2, 'Result did not open a tab.');`),
    { nativeMenu: ["File", "Open Quickly…"] },
    evaluate(`await waitFor(() => !document.querySelector('#picker').hidden, 'Native Open Quickly menu failed.');
      const input = document.querySelector('#picker-input'); input.value = 'unique-quickly-other'; input.dispatchEvent(new Event('input'));
      await waitFor(() => [...document.querySelectorAll('#picker-list [role=option]')].some(row => row.title === ${quote(c)}), 'Other result missing.');`),
    ...key("Enter", [mod]),
    evaluate(`await waitFor(() => document.querySelectorAll('.document-pane').length === 2 && document.documentElement.dataset.documentPainted === ${quote(c)}, 'Other pane did not open.');
      assert([...document.querySelectorAll('.document-pane')].some(p => p.dataset.documentPath === ${quote(b)}), 'Opening beside replaced the original pane.');`),
    ...key("O", [mod, "shift"]),
    evaluate(`await waitFor(() => !document.querySelector('#picker').hidden, 'Finder did not reopen.');
      assert(document.querySelector('.picker-scope').textContent === 'This repo', 'Scope was not remembered.');
      const input = document.querySelector('#picker-input'); input.value = 'unique-quickly-guide'; input.dispatchEvent(new Event('input'));`),
    ...key("Enter"),
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Existing result did not focus.');
      assert(document.querySelectorAll('[role=tab]').length === 3, 'Existing result duplicated a tab.');`),
    { windowCount: 1 },
  ], "read", undefined, 0, "source", { prepare: profile => fs.writeFileSync(path.join(profile, "config"), "open-in = window\nopen-quickly-scope = repo\n") });
});

await test("tabs-scroll-selection-shortcuts", async () => {
  const source = ("# Scroll\n\nA paragraph with enough text to fill the editor.\n\n").repeat(1800).slice(0, 100000);
  const a = fixture("tabs-scroll/a.md", source), b = fixture("tabs-scroll/b.md", "# Next\n");
  const key = (keyCode: string, modifiers: NonNullable<KeyboardInputEvent["modifiers"]> = []): Step[] => [
    { input: { type: "keyDown", keyCode, modifiers } }, { input: { type: "keyUp", keyCode, modifiers } },
  ];
  await launch("tabs-scroll", a, [
    evaluate(`window.scrollId = Number(document.documentElement.dataset.documentId);
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: 50000 }, scrollIntoView: true });
      await waitFor(() => view.scrollDOM.scrollTop > 1000, 'Scroll did not move.');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.savedScroll = view.scrollSnapshot().value;
      await window.simplemd.openPath(${quote(b)}, 'edit');
      await window.simplemd.activateTab(window.scrollId);
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Scrolled tab did not return.');
      const restored = document.querySelector('.cm-content').cmTile.root.view;
      assert(restored.state.selection.main.head === 50000, 'Selection lost across switch.');
      await waitFor(() => { const scroll = restored.scrollSnapshot().value; return scroll.range.head === window.savedScroll.range.head && Math.abs(scroll.yMargin - window.savedScroll.yMargin) < 3; }, 'Visible source position lost across switch.');
      const otherId = [...document.querySelectorAll('[role=tab]')].map(tab => Number(tab.dataset.documentId)).find(id => id !== window.scrollId);
      await Promise.all([window.simplemd.activateTab(otherId), window.simplemd.activateTab(window.scrollId), window.simplemd.activateTab(otherId), window.simplemd.activateTab(window.scrollId)]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)} && document.querySelectorAll('.cm-editor').length === 1, 'Rapid activations did not converge.');`),
    ...key("Tab", ["control"]),
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Control-Tab did not cycle.');`),
    ...key("1", [mod]),
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Tab number did not jump.');`),
    ...key("T", [mod]),
    evaluate(`await waitFor(() => document.querySelectorAll('[role="tab"]').length === 3, 'New tab shortcut failed.');`),
    ...key("W", [mod]),
    evaluate(`await waitFor(() => document.querySelectorAll('[role="tab"]').length === 2, 'Close tab shortcut failed.');`),
    { windowCount: 1 },
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(source));
});

await test("tabs-resident-closed-read-checker", async () => {
  const text = "# Resident reopen\n\nReadable text.\n";
  const file = fixture("tabs-resident-checker/note.md", text);
  await launch("tabs-resident-closed-read-checker", file, [
    evaluate(`window.simplemd.command('close-tab');`), { wait: 200 }, { visibility: false },
    evaluate(`await window.simplemd.openPath(${quote(file)}, 'read');`),
    assertPerfDocument(file, text),
  ], "read");
});

for (const native of [false, true]) await test(`tabs-last-close-${native ? "native" : "command"}`, async () => {
  const name = `tabs-last-close-${native ? "native" : "command"}`;
  const file = fixture(`${name}/note.md`, note);
  await launch(name, file, [
    evaluate(`window.residentToken = 'same renderer';`),
    native ? { closeWindow: true } : evaluate(`window.simplemd.command('close-tab');`),
    { wait: 200 }, { windowCount: 1 }, { visibility: false },
    evaluate(`assert(document.querySelectorAll('.cm-editor').length === 0 && document.querySelectorAll('[role="tab"]').length === 0, 'Closed layout was retained'); assert(document.documentElement.dataset.documentPath === undefined, 'Closed window retained document identity');
      await window.simplemd.openPath(${quote(file)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(file)}, 'Resident window did not reopen');
      assert(window.residentToken === 'same renderer', 'Reopen replaced resident renderer');`),
    { visibility: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(note));
});


const contextBase = { selectionPresent: false, editable: false, linkURL: "", imageURL: "", misspelledWord: "", suggestions: [] };
await test("native-menu-rebuilds", async () => {
  const a = fixture("native-menu-rebuilds/a.md", note), b = fixture("native-menu-rebuilds/b.md", "# Recent\n");
  await launch("native-menu-rebuilds", a, [
    evaluate(`await waitFor(() => document.querySelector('.document-pane[data-active=true]')?.dataset.documentId, 'No active document');
      await window.simplemd.gitStatus(Number(document.querySelector('.document-pane[data-active=true]').dataset.documentId));`),
    { nativeMenus: "capture" },
    evaluate(`await window.simplemd.setSettings({ bounds: { x: 100, y: 100, width: 850, height: 700 }, zoom: 1.1 });`),
    { nativeMenus: "unchanged" },
    evaluate(`const current = document.querySelector('.document-pane[data-active=true] [data-element=modes] button[aria-pressed=true]')?.dataset.mode;
      window.nextMenuMode = current === 'live' ? 'source' : 'live';
      window.simplemd.command('mode-' + window.nextMenuMode);
      await waitFor(() => document.querySelector('.document-pane[data-active=true] [data-element=modes] button[aria-pressed=true]')?.dataset.mode === window.nextMenuMode, 'Mode did not update');`),
    { nativeMenus: "app-only" },
    evaluate(`await window.simplemd.openPath(${quote(b)}, 'edit');`),
    { nativeMenus: "recents" },
  ], "edit");
});

await test("native-context-link-image", async () => {
  const sibling = fixture("native-context/sibling.md", "# Sibling\n");
  const image = fixture("native-context/image.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
  const file = fixture("native-context/note.md", "[Sibling](sibling.md)\n\n![Image](image.svg)\n\n[Bottom](#bottom)\n\n" + "Paragraph.\n\n".repeat(80) + "# Bottom\n");
  await launch("native-context-link-image", file, [
    evaluate(`await waitFor(() => document.querySelector('.prose a') && document.querySelector('.prose img'), 'Context fixtures did not render');`),
    { nativeContext: { selector: ".prose img", context: { ...contextBase, imageURL: new URL("file://" + image).href }, labels: ["Copy Image Address", process.platform === "darwin" ? "Reveal in Finder" : process.platform === "win32" ? "Reveal in Explorer" : "Show in File Manager"] } },
    { nativeContext: { selector: '.prose a[href="#user-content-bottom"]', context: { ...contextBase, linkURL: "#user-content-bottom" }, labels: ["Open Link", "Copy Link"], choose: "Open Link" } },
    evaluate(`await waitFor(() => document.querySelector('.document-pane [data-element=read] .scroller')?.scrollTop > 0, 'Context fragment did not scroll');`),
    { nativeContext: { selector: ".prose a", context: { ...contextBase, linkURL: new URL("file://" + sibling).href }, labels: ["Open Link", "Copy Link", "Open in New Tab"], choose: "Open in New Tab" } },
    evaluate(`await waitFor(() => document.querySelectorAll('[role=tab]').length === 2 && document.documentElement.dataset.documentPath === ${quote(sibling)}, 'Context action did not open sibling tab');`),
  ]);
});
await test("native-context-spelling", async () => {
  const text = "\ufeffwrod 😀\r\nnext  \rlast\n";
  const file = fixture("native-spelling/note.md", text);
  await launch("native-context-spelling", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-line'), 'Missing editor');`),
    { nativeContext: { selector: ".cm-line", context: { ...contextBase, editable: true, misspelledWord: "wrod", suggestions: ["word"] }, labels: ["word", "Add to Dictionary", "Cut", "Copy", "Paste", "Paste as Plain Text", "Select All"], choose: "word" } },
    evaluate(`await waitFor(() => editorText().startsWith('word'), 'Spelling action did not replace through CodeMirror');`),
    { save: true },
    evaluate(`window.simplemd.command('undo'); await waitFor(() => editorText().startsWith('wrod'), 'Spelling undo did not restore source');`),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(text));
});
await test("native-recents-identity-accent", async () => {
  const file = fixture("native-recents/note.md", "# Native\n");
  await launch("native-recents-identity-accent", file, [
    evaluate(`const ready = await window.simplemd.ready(); assert(ready.settings.recents.includes(${quote(file)}), 'Opened file missing from recents');`),
    { nativeIdentity: { file, edited: false } },
    ...appendCharacter("x"),
    { nativeIdentity: { file, edited: true } },
    evaluate(`window.simplemd.command('undo'); await waitFor(() => document.querySelector('#dirty').hidden, 'Undo retained edited state');`),
    { nativeIdentity: { file, edited: false } },
    evaluate(`document.documentElement.style.setProperty('--tab-accent', '#000000');`),
    { nativeAccent: true },
    evaluate(`if (document.body.dataset.platform !== 'linux') await waitFor(() => document.documentElement.style.getPropertyValue('--tab-accent') === document.documentElement.style.getPropertyValue('--system-accent'), 'Accent event did not update tabs');`),
    { nativeMenu: ["File", "Open Recent", "Clear Menu"] },
    evaluate(`assert((await window.simplemd.ready()).settings.recents.length === 0, 'Clear Menu retained recents'); window.simplemd.command('new'); await waitFor(() => document.documentElement.dataset.documentPath === '', 'Untitled tab did not open');`),
    { nativeIdentity: { file: "", edited: false } },
  ], "edit");
});
if (process.platform === "darwin") await test("native-find-pasteboard", async () => {
  const file = fixture("native-find/note.md", "find this word\n");
  await launch("native-find-pasteboard", file, [
    { nativeFind: null },
    evaluate(`const line = document.querySelector('.prose p'); const range = document.createRange(); range.selectNodeContents(line); window.getSelection().removeAllRanges(); window.getSelection().addRange(range);`),
    { nativeMenu: ["Edit", "Use Selection for Find"] },
    { wait: 100 },
    { nativeFind: "find this word" },
    { nativeMenu: ["Edit", "Find…"] },
    evaluate(`await waitFor(() => document.querySelector('#find-input').value === 'find this word', 'Read find did not read system pasteboard'); document.querySelector('#find-input').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); window.simplemd.command('toggle-edit'); await waitFor(() => document.querySelector('.cm-content'), 'Editor did not open');`),
    { nativeMenu: ["Edit", "Find…"] },
    evaluate(`await waitFor(() => document.querySelector('.cm-search input[name=search]')?.value === 'find this word', 'Editor find did not read system pasteboard');`),
  ]);
});

// ux-app: native opening policy, active title and edited state. Run only by the owner.
await test("ux-reader-policy-chrome", async () => {
  const file = fixture("ux-reader/note.md", "# Reader\n\nKeep these bytes.\n");
  const second = fixture("ux-reader/other.md", "# Other\n");
  await launch("ux-reader-policy-chrome", file, [
    evaluate(`assert(document.querySelector('.document-pane').dataset.view === 'read', 'Normal open did not use Read');
      const modes = document.querySelector('[data-element=modes]');
      assert(!modes.hidden && modes.querySelector('[data-mode=read]'), 'Read mode is not visible');
      const before = (await window.simplemd.ready()).settings.theme;
      document.querySelector('[data-element=read-scroll]').focus();
      for (const key of 'hello t') document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true}));
      assert(document.querySelector('.document-pane').dataset.view === 'read', 'Bare letter opened the editor');
      assert((await window.simplemd.ready()).settings.theme === before, 'Bare letter changed appearance'); const zoom = (await window.simplemd.ready()).settings.zoom; window.simplemd.command('zoom-in'); assert(Math.abs((await window.simplemd.ready()).settings.zoom - zoom - 0.2) < 0.001, 'Zoom step is too small');`),
    { nativeMenu: ["View", "Read / Edit"] },
    ...appendCharacter("x"),
    { nativeIdentity: { file, edited: true } },
    evaluate(`const edited = document.querySelector('.window-edited'); const r = edited.getBoundingClientRect(); assert(edited.textContent === 'Edited' && r.width > 0 && r.right <= innerWidth, 'Edited is offscreen');
      assert(edited.parentElement.matches('.tb-title'), 'Edited is detached from the active filename');
      assert(getComputedStyle(edited).color === (matchMedia('(prefers-color-scheme: dark)').matches ? 'rgb(184, 184, 184)' : 'rgb(96, 96, 96)'), 'Edited is not secondary text');`),
    { nativeMenu: ["View", "Read"] },
    evaluate(`await waitFor(() => document.querySelector('.document-pane').dataset.view === 'read', 'Read menu did not work'); await window.simplemd.openPath(${quote(second)});`),
    { nativeIdentity: { file: second, edited: false } },
    evaluate(`await waitFor(() => document.querySelector('.tb-title').textContent === 'other.md', 'Active title vanished with two tabs'); assert(document.title === 'other.md', 'Native title differs');`),
  ], "default");
});

await test("ux-footer-save", async () => {
  const file = fixture("ux-footer/note.md", "# Footer save\n\nKeep this text.\n");
  const html = path.join(root, "footer-saved.html"), pdf = path.join(root, "footer-saved.pdf");
  await launch("ux-footer-save", file, [
    { savePath: html },
    evaluate(`const format = document.querySelector('#export-format'); format.value = 'html'; format.dispatchEvent(new Event('change')); document.querySelector('#drag-export').click(); await waitFor(() => !document.querySelector('#drag-export').disabled, 'HTML Save did not finish'); assert(document.querySelector('#drag-export').textContent === 'Export', 'Export changed to a drag instruction');`),
    { savePath: pdf },
    evaluate(`const format = document.querySelector('#export-format'); format.value = 'pdf'; format.dispatchEvent(new Event('change')); document.querySelector('#drag-export').click(); await waitFor(() => !document.querySelector('#drag-export').disabled, 'PDF Save did not finish');`),
  ]);
  assert(fs.readFileSync(html, "utf8").includes("Footer save"), "Footer HTML Save did not write the selected path");
  assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), "%PDF-", "Footer PDF Save did not write the selected path");
});
await test("ux-conflict-save-copy", async () => {
  const source = "# Local note\n\nKeep local bytes.\n", incoming = "# Incoming version\n";
  const file = fixture("ux-conflict-copy/note.md", source), copy = path.join(root, "mine-copy.md");
  const marker = path.join(root, "copy-dirty.png");
  await launch("ux-conflict-save-copy", file, [
    ...appendCharacter("!"), { shot: marker }, { savePath: copy },
    evaluate(`await waitFor(() => !document.querySelector('#banner').hidden, 'Conflict banner missing'); const button = [...document.querySelectorAll('#banner button')].find(button => button.textContent === 'Save mine as…'); assert(button, 'Save mine as is missing'); button.click(); await waitFor(() => !button.disabled, 'Conflict Save dialog did not finish'); assert(!document.querySelector('#banner').hidden && editorText().endsWith('!'), 'Saving a copy lost the local version or conflict choices');`),
  ], "edit", { marker, file, text: incoming });
  assert.equal(fs.readFileSync(file, "utf8"), incoming, "Saving a copy replaced the incoming version");
  assert.equal(fs.readFileSync(copy, "utf8"), source + "!", "Saving a copy lost local bytes");
});

await test("outline-rail-click-jump", async () => {
  const file = fixture("outline-click.md", Array.from({ length: 40 }, (_, i) => `## Chapter ${i + 1}\n\n${"Paragraph. ".repeat(100)}\n\n`).join(""));
  await launch("outline-rail-click-jump", file, [
    evaluate(`await waitFor(() => document.querySelectorAll('.outline-strip').length === 40, 'Outline did not build');
      const button = document.querySelectorAll('.outline-strip')[20]; button.click();
      await waitFor(() => button.dataset.inView === 'true', 'Jump did not reveal heading');
      const scroll = document.querySelector('[data-element="read-scroll"]');
      assert(scroll.scrollTop > 0 && getComputedStyle(scroll).scrollbarWidth === 'none', 'Rail did not replace the scrollbar');`),
  ]);
});
await test("outline-rail-pointer-scrub", async () => {
  const file = fixture("outline-scrub.md", Array.from({ length: 40 }, (_, i) => `## Chapter ${i + 1}\n\n${"Paragraph. ".repeat(100)}\n\n`).join(""));
  await launch("outline-rail-pointer-scrub", file, [
    evaluate(`await waitFor(() => document.querySelectorAll('.outline-strip').length === 40, 'Outline did not build');
      const rail = document.querySelector('.outline-rail');
      rail.style.position = 'fixed'; rail.style.inset = '100px auto auto 400px'; rail.style.width = '28px'; rail.style.height = '400px';`),
    { input: { type: "mouseMove", x: 420, y: 110 } },
    { input: { type: "mouseDown", x: 420, y: 110, button: "left", clickCount: 1 } },
    { input: { type: "mouseMove", x: 420, y: 496, button: "left", modifiers: ["leftbuttondown"] } },
    { input: { type: "mouseUp", x: 420, y: 496, button: "left", clickCount: 1 } },
    evaluate(`const scroll = document.querySelector('[data-element="read-scroll"]');
      await waitFor(() => scroll.scrollTop / (scroll.scrollHeight - scroll.clientHeight) > 0.95, 'Pointer scrub did not reach the end');
      await waitFor(() => document.querySelector('.outline-strip:last-child')?.dataset.inView === 'true', 'Scrub did not reveal the final heading');`),
  ]);
});

const blog = process.env.SMD_BYTE_BLOG_DIR;
if (blog) for (const name of fs.readdirSync(blog).filter((name) => name.endsWith(".mdx")).sort()) {
  await test(`bytes-blog-${name}`, async () => {
    const source = path.join(blog, name);
    const original = fs.readFileSync(source);
    const file = fixture(`bytes-blog-${name}/${name}`, "");
    fs.copyFileSync(source, file);
    await launch(`bytes-blog-${name}`, file, [{ save: true }], "edit");
    assert.deepEqual(fs.readFileSync(file), original, "Blog copy did not round-trip byte-for-byte.");
    assert.deepEqual(fs.readFileSync(source), original, "Original blog file changed during the check.");
  });
}

assert(results.length, `No smoke cases match ${quote(filter)}.`);
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
console.log(`Artifacts: ${root}`);
console.log(`${results.filter(result => result.status === "passed").length}/${results.length} smoke cases passed.`);
process.exitCode = results.some(result => result.status === "failed") ? 1 : 0;

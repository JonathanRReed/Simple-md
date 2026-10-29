import assert from "node:assert/strict";
import type { KeyboardInputEvent } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureDriverRun, type DriverEvent } from "../bench";
import type { DriverStep } from "../src/main/driver";
import { perfFixtures, sha256, writePerfFixtures } from "./perf-fixtures";

type State = "process-cold-fresh-profile" | "process-cold-reused-profile" | "resident-visible" | "resident-hidden" | "resident-new-file-miss" | "A-to-B-to-A";
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid performance sample");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
export function summarizeGate(values: number[], target: number, minimum: number, statistic: "p95" | "median" = "p95") {
  const median = percentile(values, 0.5), p95 = percentile(values, 0.95), p99 = percentile(values, 0.99);
  const measured = statistic === "median" ? median : p95;
  return { status: values.length >= minimum && measured !== null && measured < target ? "pass" : "fail", count: values.length, median, p95, p99, target, statistic, minimum };
}
type EventQuantile = { lower: number; upper: number; upperExclusive: boolean };
export function summarizeEventTiming(record: { counts: { keydown: number; beforeinput: number }; events: { name: string; duration: number }[] }) {
  function summarize(name: "keydown" | "beforeinput") {
    const durations = record.events.filter((event) => event.name === name).map((event) => event.duration).sort((a, b) => a - b);
    const total = record.counts[name];
    const censored = Math.max(0, total - durations.length);
    // Some Chromium versions do not expose beforeinput in Event Timing.
    // A DOM beforeinput counter alone does not prove API support.
    const unsupported = name === "beforeinput" && durations.length === 0;
    const quantile = (fraction: number): EventQuantile | null => {
      if (!total || unsupported) return null;
      const rank = Math.ceil(total * fraction);
      const value = durations[rank - censored - 1];
      return value === undefined ? { lower: 0, upper: 16, upperExclusive: true } : { lower: value, upper: value, upperExclusive: false };
    };
    return { total, reported: durations.length, censoredBelow16: unsupported ? null : censored, p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99), reason: unsupported ? "beforeinput is not exposed by this Event Timing implementation; the rAF probe remains a separate lower bound." : "Trusted DOM event counts supply the denominator. Unreported durations are censored below 16 ms, with 8 ms quantization." };
  }
  return { keydown: summarize("keydown"), beforeinput: summarize("beforeinput") };
}
const appRoot = path.resolve(import.meta.dirname, "..");
const repo = path.dirname(appRoot);
const quote = JSON.stringify;
const mod = process.platform === "darwin" ? "meta" : "control";
const evaluate = (code: string): DriverStep => ({ eval: `(async () => { ${code} })()` });
const waitFor = `const waitFor = async (predicate) => { const deadline = performance.now() + 30000; while (!predicate()) { if (performance.now() > deadline) throw new Error('Timed out waiting for perf assertion'); await new Promise(r => setTimeout(r, 10)); } };`;
function command(executable: string, args: string[]): string | null {
  try { return execFileSync(executable, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; }
}
function treeHash(directory: string) {
  if (!fs.existsSync(directory)) return null;
  const files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((name) => fs.statSync(path.join(directory, name)).isFile()).sort();
  const manifest = files.map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(directory, name))) }));
  return { sha256: sha256(JSON.stringify(manifest)), files: manifest };
}
function dirtyHash() {
  const patch = execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: repo });
  const names = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  return sha256(Buffer.concat([patch, Buffer.from(JSON.stringify(names.map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(repo, name))) }))))]));
}
function recordValue(events: DriverEvent[], name: string): unknown {
  const matches = events.filter(({ data }) => data.kind === "record" && data.name === name);
  if (matches.length !== 1) throw new Error(`Missing or duplicate driver record: ${name}`);
  return matches[0]!.data.value;
}
export function readableSample(events: DriverEvent[], start: number, expectedPath: string): number {
  const arrival = events.find(({ elapsedMs, data }) => elapsedMs >= start && data.marker === "file-open-arrival" && data.path === expectedPath);
  const readable = events.find(({ elapsedMs, data }) => elapsedMs >= start && data.marker === "first-readable" && data.path === expectedPath);
  if (!arrival || !readable || readable.elapsedMs < arrival.elapsedMs) throw new Error(`Missing matching first-readable marker: ${expectedPath}`);
  return readable.elapsedMs - start;
}
function assertDocument(file: string, text: string): DriverStep {
  const heading = /^# (.+)$/m.exec(text.replace(/^\uFEFF/, ""))?.[1];
  return evaluate(`${waitFor}
    const file = ${quote(file)};
    await waitFor(() => document.documentElement.dataset.firstReadable === file && document.documentElement.dataset.documentPainted === file);
    if (document.documentElement.dataset.documentPath !== file) throw new Error('Wrong perf file');
    if (document.querySelector('#doc h1')?.textContent !== ${quote(heading)}) throw new Error('Failed perf heading render');
    await waitFor(() => !document.querySelector('#doc pre.mermaid'));
    if ([...document.querySelectorAll('#doc .diagram-error')].some(el => !el.hidden)) throw new Error('Failed perf diagram render');
    if (${quote(file.endsWith("math.md"))} && !document.querySelector('#doc .katex')) throw new Error('Failed perf math render');
    if (${quote(file.endsWith("fences.md") || file.endsWith("small.md"))} && !document.querySelector('#doc .shiki')) throw new Error('Failed perf highlight render');
  `);
}
function keys(keyCode: string, modifiers: KeyboardInputEvent["modifiers"] = []): DriverStep[] {
  return [{ input: { type: "keyDown", keyCode, modifiers } }, { input: { type: "keyUp", keyCode, modifiers } }];
}

export async function perfGate(): Promise<void> {
  const smoke = process.argv.includes("--smoke");
  const count = smoke ? 2 : 20;
  fs.mkdirSync(path.join(repo, ".audit"), { recursive: true });
  const root = fs.mkdtempSync(path.join(repo, ".audit/perf-"));
  const fixtureDirectory = path.join(root, "fixtures");
  const manifest = writePerfFixtures(fixtureDirectory);
  const fixtureText = perfFixtures();
  const executable = path.join(appRoot, "node_modules/electron/dist", fs.readFileSync(path.join(appRoot, "node_modules/electron/path.txt"), "utf8").trim());
  const sourceDirtyHash = dirtyHash();
  const samples: { state: State; fixture: string; sample: number; ms: number; cache: object; loadAverage: number[]; run: string }[] = [];
  const memory: { run: string; at: number; processes: unknown; physicalBytes: number; rssBytes: number; loadAverage: number[] }[] = [];
  const typing: { mode: string; position: string; eventTiming: ReturnType<typeof summarizeEventTiming>; rawEventTiming: unknown; lowerBound: unknown; finalSha256: string; expectedSha256: string }[] = [];
  const runs: object[] = [];
  const failures: string[] = [];
  const failedSamples: { state: State; fixture: string; sample: number; run: string; error: string }[] = [];
  const runResults = new Map<string, Awaited<ReturnType<typeof measureDriverRun>>>();
  const loadAtBarrier = new Map<string, number[]>();
  const receipt = {
    schemaVersion: 1, createdAt: new Date().toISOString(), command: process.argv, reducedSmoke: smoke,
    revision: command("git", ["rev-parse", "HEAD"]), branch: command("git", ["branch", "--show-current"]), dirtyPatchHash: sourceDirtyHash,
    memoryHelper: { sha256: null as string | null, sourceSha256: sha256(fs.readFileSync(path.join(appRoot, "native/src/bin/perf-memory.rs"))) },
    lockfileHash: sha256(fs.readFileSync(path.join(appRoot, "bun.lock"))), dist: treeHash(path.join(appRoot, "dist")),
    asar: { sha256: null, reason: "Development Electron app with production Bun bundles; no ASAR is launched." },
    versions: { bun: Bun.version, harnessNode: process.versions.node, electron: null as unknown, appNode: null as unknown },
    host: { platform: process.platform, arch: process.arch, model: command("sysctl", ["-n", "hw.model"]) ?? os.cpus()[0]?.model, osRelease: os.release(), macOSBuild: command("sw_vers", ["-buildVersion"]), powerSource: command("pmset", ["-g", "batt"]), thermalState: { pmset: command("pmset", ["-g", "therm"]), electron: null as unknown }, onBatteryPower: null as unknown, displayRefreshRate: null as unknown, displays: null as unknown, logicalCores: os.cpus().length, loadAverageStart: os.loadavg(), uptime: command("uptime", []) },
    fixtures: manifest, cachePolicy: {
      osFileCache: "Not purged. Process cold does not mean filesystem cold.",
      fresh: "New user-data and NODE_COMPILE_CACHE directories, worker inherits this compile-cache directory. No disk render cache, Shiki starts unloaded, no retained DOM.",
      reused: "Explicit seed process exits cleanly and flushes compile and disk render caches, then a new process uses those directories. Shiki and DOM start empty in each process.",
      resident: "Seeded small document; main/worker compile caches and Shiki TS loaded. Disk render cache reused. Hidden is confirmed with BrowserWindow.isVisible. Revisit explicitly opens A, then B, then A. DOM follows current implementation; replacements destroy old blocks.",
      miss: "Unique fixture path for every sample. Not in recents or disk cache before the timed open. In-process Shiki/block caches remain warm and are not called cold.",
    },
    limits: ["Parent stdout receipt timestamps include IPC and pipe scheduling. Double rAF marks a paint opportunity, not physical display scanout.", "First-readable does not await diagrams or fonts. Current payload generation still highlights before mount; this run does not implement first-screen rendering.", "Typing Event Timing has a 16 ms reporting floor and 8 ms quantization. Sub-threshold events are censored, never treated as zero. beforeinput support and trusted counts are recorded separately.", "Editor tokenization has no fully-highlighted completion signal. That marker applies to read and split previews only; CodeMirror background parsing is not timed.", "CDP IME is a composition-path exercise, not a physical keyboard or native input-method qualification.", "ASAR packaging and Windows runtime are not measured by a development macOS run."],
    runs, samples, failedSamples, typing, memory, failures, gates: {} as Record<string, unknown>, loadAverageEnd: [] as number[],
  };
  function profile(name: string, mode = "source") {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ mode, autosave: false, spacePreview: false, launchAtLogin: false, peekPrompted: true, spellcheck: false, recents: [] }));
    return directory;
  }
  const targetDirectory = path.join(root, "native");
  const helper = path.join(targetDirectory, "release", `perf-memory${process.platform === "win32" ? ".exe" : ""}`);
  async function launch(name: string, file: string, userData: string, steps: DriverStep[], intent = "peek") {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    const drive = path.join(directory, "drive.json");
    fs.writeFileSync(drive, JSON.stringify(steps));
    const env: NodeJS.ProcessEnv = { ...process.env, SMD_PERF: "1", SMD_TRACE: "1", SMD_DRIVE: drive, SMD_USER_DATA: userData, SMD_INTENT: intent, NODE_COMPILE_CACHE: path.join(userData, "compile-cache") };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_DISABLE_COMPILE_CACHE;
    const startedLoad = os.loadavg();
    const partialEvents: DriverEvent[] = [];
    let result: Awaited<ReturnType<typeof measureDriverRun>>;
    try { result = await measureDriverRun({ executable, args: [appRoot, file], cwd: appRoot, env, logPath: path.join(directory, "electron.log"), timeoutMs: 600_000,
      onEvent(event) {
        partialEvents.push(event);
        if (event.data.kind === "barrier" && typeof event.data.name === "string") loadAtBarrier.set(event.data.name, os.loadavg());
        if (event.data.kind !== "memory") return;
        const processes = event.data.processes;
        if (!Array.isArray(processes) || !processes.length) throw new Error("Missing app.getAppMetrics processes");
        const pids = processes.map((value: unknown) => {
          if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Invalid app metric PID");
          return String(value.pid);
        });
        if (new Set(pids).size !== pids.length) throw new Error("Duplicate app metric PID");
        const measured: unknown = JSON.parse(execFileSync(helper, pids, { encoding: "utf8" }));
        if (!Array.isArray(measured) || measured.length !== pids.length) throw new Error("Incomplete process memory sample");
        let physicalBytes = 0, rssBytes = 0;
        for (const value of measured) {
          if (typeof value !== "object" || value === null || !("physicalBytes" in value) || typeof value.physicalBytes !== "number" || !("rssBytes" in value) || typeof value.rssBytes !== "number" || !("pid" in value) || !pids.includes(String(value.pid))) throw new Error("Invalid memory helper result");
          physicalBytes += value.physicalBytes; rssBytes += value.rssBytes;
        }
        memory.push({ run: name, at: event.elapsedMs, processes: { metrics: processes, measured }, physicalBytes, rssBytes, loadAverage: os.loadavg() });
        const versions = event.data.versions;
        if (typeof versions === "object" && versions !== null && "electron" in versions && "node" in versions) { receipt.versions.electron = versions.electron; receipt.versions.appNode = versions.node; }
        receipt.host.thermalState.electron = event.data.thermalState;
        receipt.host.onBatteryPower = event.data.onBatteryPower;
        receipt.host.displays = event.data.displays;
        receipt.host.displayRefreshRate = Array.isArray(event.data.displays) ? event.data.displays.map((display: Record<string, unknown>) => ({ id: display.id, hz: display.displayFrequency })) : null;
      },
    });
    } catch (error) {
      const barriers: Record<string, number> = {};
      for (const event of partialEvents) if (event.data.kind === "barrier" && typeof event.data.name === "string") barriers[event.data.name] = event.elapsedMs;
      runResults.set(name, { events: partialEvents, barriers, elapsedMs: partialEvents.at(-1)?.elapsedMs ?? 0 });
      runs.push({ name, file, profile: userData, loadAverageStart: startedLoad, loadAverageEnd: os.loadavg(), events: partialEvents, error: String(error) });
      throw error;
    }
    runs.push({ name, file, profile: userData, compileCache: env.NODE_COMPILE_CACHE, loadAverageStart: startedLoad, loadAverageEnd: os.loadavg(), ...result });
    runResults.set(name, result);
    return result;
  }
  function addSample(state: State, fixture: string, sample: number, result: Awaited<ReturnType<typeof launch>>, run: string, file: string, barrier?: string) {
    const start = barrier ? result.barriers[barrier] : 0;
    if (start === undefined) throw new Error(`Missing barrier ${barrier}`);
    samples.push({ state, fixture, sample, ms: readableSample(result.events, start, file), run, loadAverage: barrier ? loadAtBarrier.get(barrier) ?? os.loadavg() : os.loadavg(), cache: { profile: state.includes("fresh") ? "fresh" : "reused", compile: state.includes("fresh") ? "empty at spawn" : "seeded", diskRender: state === "resident-new-file-miss" ? "miss" : "see read-and-hash-end markers", shiki: state.startsWith("process-cold") ? "new worker; warmup may race foreground" : "resident, languages reused", retainedDOM: state === "resident-visible" || state === "resident-hidden" ? "same-file mount may reuse blocks" : "document replaced" } });
  }
  async function attempt(name: string, operation: () => Promise<void>) {
    console.log(`perf: ${name}`);
    try { await operation(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); console.error(failures.at(-1)); }
  }
  try {
    if (!receipt.dist) throw new Error("Build dist before running perf:gate");
    if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("Absolute memory gate requires macOS or Windows");
    execFileSync("cargo", ["build", "--locked", "--release", "--manifest-path", path.join(appRoot, "native/Cargo.toml"), "--bin", "perf-memory", "--target-dir", targetDirectory], { stdio: "inherit" });
    receipt.memoryHelper.sha256 = sha256(fs.readFileSync(helper));
    const smallFile = path.join(fixtureDirectory, "small.md");
    const coldFiles = ["small.md", "medium.md"];
    const reused = profile("cold-reused");
    await launch("seed-reused", smallFile, reused, [assertDocument(smallFile, fixtureText["small.md"]!), evaluate(`await window.simplemd.openPath(${quote(path.join(fixtureDirectory, "medium.md"))}, 'peek');`), assertDocument(path.join(fixtureDirectory, "medium.md"), fixtureText["medium.md"]!), { wait: 500 }]);
    for (let i = 0; i < count; i++) {
      for (const state of ["process-cold-fresh-profile", "process-cold-reused-profile"] as const) await attempt(`${state}-${i}`, async () => {
        const fixture = coldFiles[i % coldFiles.length]!;
        const file = path.join(fixtureDirectory, fixture);
        const name = `${state}-${i}`;
        const result = await launch(name, file, state === "process-cold-fresh-profile" ? profile(`fresh-${i}`) : reused, [assertDocument(file, fixtureText[fixture]!), { shot: path.join(root, `${name}.png`) }]);
        addSample(state, fixture, i, result, name, file);
      });
    }
    const normal = smoke ? ["small.md", "unicode.md"] : Object.keys(fixtureText).filter((name) => !["huge.md", "ceiling.md", "typing-100k.md"].includes(name));
    for (const state of ["resident-visible", "resident-hidden", "resident-new-file-miss", "A-to-B-to-A"] as const) {
      const names = state === "resident-new-file-miss" && !smoke ? [...normal, "huge.md", "ceiling.md"] : normal;
      for (const fixture of names) await attempt(`${state}/${fixture}`, async () => {
        const run = `${state}-${fixture}`;
        const scheduled: { file: string; sample: number; barrier: string }[] = [];
        const steps: DriverStep[] = [assertDocument(smallFile, fixtureText["small.md"]!)];
        const original = path.join(fixtureDirectory, fixture);
        if (state !== "resident-new-file-miss") steps.push(evaluate(`if (!(await window.simplemd.openPath(${quote(original)}, 'peek'))) throw new Error('Warm seed failed');`), assertDocument(original, fixtureText[fixture]!));
        for (let sample = 0; sample < count; sample++) {
          let file = original;
          if (state === "resident-new-file-miss") { file = path.join(fixtureDirectory, `miss-${sample}-${fixture}`); fs.copyFileSync(original, file); }
          if (state === "A-to-B-to-A") {
            steps.push(evaluate(`if (!(await window.simplemd.openPath(${quote(file)}, 'peek'))) throw new Error('A seed open failed');`), assertDocument(file, fixtureText[fixture]!), evaluate(`if (!(await window.simplemd.openPath(${quote(path.join(fixtureDirectory, "typing-100k.md"))}, 'peek'))) throw new Error('B seed open failed');`));
          }
          const barrier = `${state}-${sample}-${fixture}`;
          if (state === "resident-hidden") steps.push(evaluate("window.simplemd.hide();"), { wait: 30 }, { visibility: false });
          const assertion = assertDocument(file, fixtureText[fixture]!);
          if (!("eval" in assertion)) throw new Error("Invalid document assertion step");
          steps.push({ barrier }, { record: { name: barrier, eval: `(async () => {
            try {
              if (!(await window.simplemd.openPath(${quote(file)}, 'peek'))) throw new Error('Measured open failed');
              await ${assertion.eval};
              return true;
            } catch (error) { return String(error); }
          })()` } });
          if (sample === 0) steps.push({ shot: path.join(root, `${state}-${fixture}.png`) });
          scheduled.push({ file, sample, barrier });
        }
        try { await launch(run, smallFile, profile(`${run}-profile`), steps); }
        finally {
          const result = runResults.get(run);
          if (result) for (const entry of scheduled) {
            const outcome = result.events.find(({ data }) => data.kind === "record" && data.name === entry.barrier)?.data.value;
            if (outcome === true) addSample(state, fixture, entry.sample, result, run, entry.file, entry.barrier);
            else {
              const error = typeof outcome === "string" ? outcome : "Driver ended before this sample completed";
              failedSamples.push({ state, fixture, sample: entry.sample, run, error });
              failures.push(`${run}/${entry.sample}: ${error}`);
            }
          }
        }
      });
    }
    await attempt("settled-memory", async () => {
      const file = path.join(fixtureDirectory, "medium.md");
      await launch("settled-memory", file, profile("memory-profile", "live"), [
        evaluate(`${waitFor} await waitFor(() => document.querySelector('.cm-content[contenteditable="true"]')); if (document.documentElement.dataset.documentPath !== ${quote(file)} || document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() !== ${quote(fixtureText['medium.md'])}) throw new Error('Wrong settled memory document');`),
        { wait: 5000 }, ...Array.from({ length: 5 }, (_, i): DriverStep[] => [{ memory: `settled-${i}` }, { wait: 1000 }]).flat(),
      ], "edit");
    });
    for (const mode of smoke ? ["source"] : ["live", "source", "split"]) for (const position of smoke ? ["top"] : ["top", "middle", "end"]) await attempt(`typing-${mode}-${position}`, async () => {
      const text = fixtureText["typing-100k.md"]!;
      const file = path.join(fixtureDirectory, `typing-${mode}-${position}.md`);
      fs.writeFileSync(file, text);
      const at = position === "top" ? 0 : position === "middle" ? 50_000 : text.length;
      const steps: DriverStep[] = [evaluate(`${waitFor}
        await waitFor(() => document.querySelector('.cm-content[contenteditable="true"]'));
        const content = document.querySelector('.cm-content');
        const view = content.cmTile?.root?.view;
        if (!view || view.state.doc.length !== 100000) throw new Error('100k editor driver unavailable');
        view.dispatch({ selection: { anchor: ${at} }, scrollIntoView: true }); view.focus();
        window.perfEvents = []; window.perfCounts = { keydown: 0, beforeinput: 0 }; window.perfRaf = [];
        window.perfObserver = new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.name === 'keydown' || e.name === 'beforeinput') window.perfEvents.push(e.toJSON()); });
        window.perfObserver.observe({ type: 'event', durationThreshold: 16 });
        for (const name of ['keydown', 'beforeinput']) content.addEventListener(name, e => {
          if (e.isTrusted) window.perfCounts[name]++;
          if (name === 'beforeinput') { const start = performance.now(); requestAnimationFrame(() => window.perfRaf.push(performance.now() - start)); }
        });
      `), { wait: 200 }];
      const letters = smoke ? "abcd" : "abcdefghijklmnopqrstuvwxyz0123456789abcd";
      for (const letter of letters) steps.push(...keys(letter.toUpperCase()).slice(0, 1), { input: { type: "char", keyCode: letter } }, ...keys(letter.toUpperCase()).slice(1), { wait: 25 });
      // A burst, selection replacement, backspace, and undo all exercise real input.
      for (const letter of "burst") steps.push(...keys(letter.toUpperCase()).slice(0, 1), { input: { type: "char", keyCode: letter } }, ...keys(letter.toUpperCase()).slice(1));
      steps.push({ wait: 700 }, ...keys("Backspace"), ...keys("Z", [mod]), { wait: 100 });
      // Undo returns the deleted final t. Replace it through a selection with t.
      steps.push(...keys("Left", ["shift"]), { input: { type: "char", keyCode: "t" } }, { wait: 100 });
      // Paste through Chromium's clipboard command; IME through Chromium's input protocol.
      steps.push({ paste: "PASTE" }, { wait: 200 });
      steps.push({ debug: { method: "Input.imeSetComposition", params: { text: "に", selectionStart: 1, selectionEnd: 1 } } }, { wait: 30 }, { debug: { method: "Input.imeSetComposition", params: { text: "日本", selectionStart: 2, selectionEnd: 2 } } }, { debug: { method: "Input.insertText", params: { text: "日本" } } }, { wait: 200 });
      const inserted = letters + "burstPASTE日本";
      const expected = text.slice(0, at) + inserted + text.slice(at);
      steps.push(evaluate(`${waitFor}
        const view = document.querySelector('.cm-content').cmTile.root.view;
        const expected = ${quote(expected)};
        await waitFor(() => view.state.doc.toString() === expected);
        window.simplemd.command('save');
        await waitFor(() => document.querySelector('#dirty').hidden);
        await new Promise(r => setTimeout(r, 200));
      `), { record: { name: "typing", eval: `({ supported: PerformanceObserver.supportedEntryTypes, counts: window.perfCounts, events: window.perfEvents, lowerBound: window.perfRaf, finalText: document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() })` } }, { shot: path.join(root, `typing-${mode}-${position}.png`) });
      const result = await launch(`typing-${mode}-${position}`, file, profile(`typing-${mode}-${position}-profile`, mode), steps, "edit");
      const record = recordValue(result.events, "typing");
      if (typeof record !== "object" || record === null || !("events" in record) || !Array.isArray(record.events) || !("lowerBound" in record) || !("finalText" in record) || record.finalText !== expected) throw new Error("Missing or invalid typing evidence");
      assert.equal(fs.readFileSync(file, "utf8"), expected, "Final saved typing bytes differ");
      if (!("counts" in record) || typeof record.counts !== "object" || record.counts === null || !("keydown" in record.counts) || typeof record.counts.keydown !== "number" || !("beforeinput" in record.counts) || typeof record.counts.beforeinput !== "number") throw new Error("Missing trusted typing counts");
      const events = record.events.map((event: unknown) => {
        if (typeof event !== "object" || event === null || !("name" in event) || typeof event.name !== "string" || !("duration" in event) || typeof event.duration !== "number") throw new Error("Invalid Event Timing entry");
        return { name: event.name, duration: event.duration };
      });
      typing.push({ mode, position, eventTiming: summarizeEventTiming({ counts: { keydown: record.counts.keydown, beforeinput: record.counts.beforeinput }, events }), rawEventTiming: record, lowerBound: record.lowerBound, finalSha256: sha256(fs.readFileSync(file)), expectedSha256: sha256(expected) });
    });
  } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  for (const state of ["process-cold-fresh-profile", "process-cold-reused-profile"] as const) receipt.gates[state] = summarizeGate(samples.filter((sample) => sample.state === state).map((sample) => sample.ms), 800, smoke ? 2 : 20);
  const normalFixtures = smoke ? ["small.md", "unicode.md"] : Object.keys(fixtureText).filter((name) => !["huge.md", "ceiling.md", "typing-100k.md"].includes(name));
  for (const state of ["resident-visible", "resident-hidden", "resident-new-file-miss", "A-to-B-to-A"] as const) {
    for (const fixture of normalFixtures) receipt.gates[`${state}/${fixture}`] = summarizeGate(samples.filter((sample) => sample.state === state && sample.fixture === fixture).map((sample) => sample.ms), 150, smoke ? 2 : 20);
  }
  for (const fixture of smoke ? normalFixtures : [...normalFixtures, "huge.md", "ceiling.md"]) receipt.gates[`first-screen/${fixture}`] = summarizeGate(samples.filter((sample) => sample.state === "resident-new-file-miss" && sample.fixture === fixture).map((sample) => sample.ms), 200, smoke ? 2 : 20);
  receipt.gates.memory = { ...summarizeGate(memory.map((sample) => sample.physicalBytes / 1_000_000), 200, 5, "median"), unit: "MB decimal", metric: process.platform === "win32" ? "private working set" : "ri_phys_footprint", rssMB: { median: percentile(memory.map((sample) => sample.rssBytes / 1_000_000), 0.5), p95: percentile(memory.map((sample) => sample.rssBytes / 1_000_000), 0.95) } };
  for (const mode of smoke ? ["source"] : ["live", "source", "split"]) for (const position of smoke ? ["top"] : ["top", "middle", "end"]) {
    const sample = typing.find((value) => value.mode === mode && value.position === position);
    const keydown = sample?.eventTiming.keydown;
    const p95 = keydown?.p95;
    receipt.gates[`typing/${mode}/${position}`] = {
      status: sample && [sample.eventTiming.keydown, sample.eventTiming.beforeinput].every((event) => event.p95 && (event.p95.upper < 16 || event.p95.upper === 16 && event.p95.upperExclusive)) ? "pass" : "fail",
      median: keydown?.p50 ?? null, p95: p95 ?? null, p99: keydown?.p99 ?? null, target: 16,
      eventTiming: sample?.eventTiming ?? null,
      lowerBound: sample && Array.isArray(sample.lowerBound) ? { median: percentile(sample.lowerBound, 0.5), p95: percentile(sample.lowerBound, 0.95), p99: percentile(sample.lowerBound, 0.99) } : null,
      reason: !sample ? "Typing run failed or produced no verified saved document." : "Strict 16 ms qualification is limited by Event Timing's reporting floor and 8 ms quantization; beforeinput support is reported separately.",
    };
  }
  receipt.gates["tab-switch-100k"] = { status: "n/a", reason: "Not applicable yet. Tabs do not exist.", target: 50 };
  receipt.gates["typing-two-panes"] = { status: "n/a", reason: "Not applicable yet. Two document panes do not exist. Split is the existing source plus preview mode.", target: 16 };
  receipt.gates.correctness = { status: failures.length ? "fail" : "pass", failures };
  receipt.loadAverageEnd = os.loadavg();
  const output = path.join(root, "receipt.json");
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  const failed = Object.values(receipt.gates).some((gate) => typeof gate === "object" && gate !== null && "status" in gate && gate.status === "fail");
  console.log(`Performance gates: ${failed ? "FAIL" : "PASS"}${smoke ? " (reduced smoke, absolute thresholds are non-blocking)" : ""}`);
  console.log(`Receipt: ${output}`);
  process.exitCode = smoke ? (failures.length ? 1 : 0) : failed ? 1 : 0;
}

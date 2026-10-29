// SMD_BENCH_STARTUP=0 skips Electron startup and measures only the rendering pipeline.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderBlocks } from "./src/main/markdown";

let failures = 0;

function budget(name: string, ms: number, limit: number): void {
  const ok = ms <= limit;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${name}: ${ms.toFixed(1)}ms (budget ${limit}ms)`);
}

// A large synthetic document: 6000 sections with code fences, ~2MB.
function bigDoc(): string {
  const parts: string[] = [];
  for (let i = 0; i < 6000; i++) {
    parts.push(
      `## Section ${i}\n\nSome *text* with \`code\` and a [link](http://x.com/${i}). ` +
        "lorem ipsum ".repeat(20) +
        `\n\n- item a\n- item b\n\n\`\`\`ts\nconst x${i} = ${i}\n\`\`\`\n`,
    );
  }
  return parts.join("\n");
}

const note = `# Small note\n\nSome **text** and a [link](https://example.com).\n\n\`\`\`ts\nconst a = 1\n\`\`\`\n\n$$\nE=mc^2\n$$\n`;

const RENDER_BUDGETS = [
  { key: "cold", name: "cold first render including Shiki", limit: 400 },
  { key: "small", name: "warm small render, each sample averages 50 renders", limit: 5 },
  { key: "big", name: "first render, 2MB document", limit: 600 },
  { key: "unchanged", name: "unchanged 2MB render", limit: 110 },
  { key: "edit", name: "one heading edited in 2MB", limit: 130 },
] as const;

type RenderSample = Record<(typeof RENDER_BUDGETS)[number]["key"], number>;

function isRenderSample(value: unknown): value is RenderSample {
  if (typeof value !== "object" || value === null) return false;
  return RENDER_BUDGETS.every(({ key }) => {
    const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    return typeof field === "number" && Number.isFinite(field) && field >= 0;
  });
}

async function renderSample(): Promise<RenderSample> {
  let t = performance.now();
  await renderBlocks(note, null);
  const cold = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < 50; i++) await renderBlocks(note, null);
  const small = (performance.now() - t) / 50;
  const text = bigDoc();
  t = performance.now();
  const first = await renderBlocks(text, "/tmp/bench/big.md");
  const big = performance.now() - t;
  t = performance.now();
  await renderBlocks(text, "/tmp/bench/big.md");
  const unchanged = performance.now() - t;
  t = performance.now();
  const second = await renderBlocks(text.replace("## Section 3000", "## Section 3000 edited"), "/tmp/bench/big.md");
  const edit = performance.now() - t;
  if (first.blocks.length !== second.blocks.length) throw new Error("Block count drifted after one heading edit");
  const changed = first.blocks.filter((block, index) => block.key !== second.blocks[index]!.key).length;
  if (changed !== 1) throw new Error(`One heading edit changed ${changed} blocks`);
  return { cold, small, big, unchanged, edit };
}

async function renderBench(): Promise<void> {
  const samples: RenderSample[] = [];
  for (let sample = 0; sample < 5; sample++) {
    const child = spawn(process.execPath, [import.meta.filename, "--render-sample"], {
      cwd: import.meta.dirname, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    if (code !== 0) throw new Error(`Render sample failed with exit ${code}\n${errors}`);
    const result: unknown = JSON.parse(output);
    if (!isRenderSample(result)) throw new Error("Render sample returned invalid timings");
    samples.push(result);
  }
  for (const { key, name, limit } of RENDER_BUDGETS) {
    const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    budget(`${name}, median of 5`, values[2]!, limit);
    console.log(`info  range: ${values[0]!.toFixed(1)}-${values[4]!.toFixed(1)}ms`);
  }
  console.log("info  rendering samples use fresh processes and exclude process startup; exactly one block changes per heading edit");
}

export async function measureStartup(options: {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  expectedName: string;
  timeoutMs?: number;
}): Promise<number> {
  let output = "";
  let usableAt: number | undefined;
  const started = performance.now();
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (data: Buffer) => {
    output += data.toString();
    if (usableAt !== undefined) return;
    for (const match of output.matchAll(/trace document-usable id=\d+ name=([^\r\n]+): [\d.]+ms/g)) {
      if (match[1] === options.expectedName) usableAt = performance.now() - started;
    }
  };
  child.stderr.on("data", collect);
  child.stdout.on("data", collect);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 20_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (timedOut || code !== 0 || usableAt === undefined || /driver (?:eval )?failed/.test(output)) {
    throw new Error(`Startup failed, exit=${code}, timeout=${timedOut}, usable=${usableAt !== undefined}\n${output}`);
  }
  return usableAt;
}

async function startupBench(): Promise<void> {
  const { default: electron } = await import("electron");
  const exe: unknown = electron;
  if (typeof exe !== "string" || !fs.existsSync(exe)) {
    failures++;
    console.error("FAIL  startup trace requires the local Electron binary");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smd-bench-"));
  const fixture = path.join(root, "bench-note.md");
  const drive = path.join(root, "drive.json");
  fs.writeFileSync(fixture, note);
  fs.writeFileSync(drive, JSON.stringify([{ eval: `(() => {
    const expected = ${JSON.stringify(fixture)};
    const root = document.documentElement;
    const editor = document.querySelector('.cm-content[contenteditable="true"]');
    const preview = document.getElementById('preview');
    if (root.dataset.documentPainted !== expected || root.dataset.documentPath !== expected)
      throw new Error('Benchmark document was not painted');
    if (!editor?.textContent?.includes('Small note')) throw new Error('Benchmark source is not editable');
    if (preview?.querySelector('h1')?.textContent !== 'Small note' || !preview.querySelector('.shiki') || !preview.querySelector('.katex'))
      throw new Error('Benchmark preview is incomplete');
    if (preview.getBoundingClientRect().width === 0) throw new Error('Benchmark preview is hidden');
  })()` }]));
  const samples: number[] = [];
  try {
    for (let sample = 0; sample < 5; sample++) {
      const profile = path.join(root, `profile-${sample}`);
      fs.mkdirSync(profile);
      fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
        mode: "split", autosave: false, spacePreview: false, launchAtLogin: false, recents: [],
      }));
      const env: NodeJS.ProcessEnv = { ...process.env, SMD_TRACE: "1", SMD_DRIVE: drive, SMD_USER_DATA: profile, SMD_INTENT: "edit" };
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        samples.push(await measureStartup({ executable: exe, args: [".", fixture], cwd: import.meta.dirname, env, expectedName: "bench-note.md" }));
      } catch (error) {
        failures++;
        console.error(`FAIL  startup sample ${sample + 1}`, error);
      }
    }
    if (samples.length === 5) {
      samples.sort((a, b) => a - b);
      budget("spawn to correct editable split frame, median of 5", samples[2]!, 650);
      console.log(`info  startup range: ${samples[0]!.toFixed(1)}-${samples[4]!.toFixed(1)}ms, 5 fresh profiles, shared OS/compile caches`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main && process.argv.includes("--worker-mdx")) {
  const at = process.argv.indexOf("--worker-mdx");
  const baseline = process.argv[at + 1];
  const file = process.argv[at + 2];
  if (!baseline || !file) throw new Error("Expected baseline bundle and blog post paths");
  await (await import("./scripts/bench-render")).workerMdxBench(path.resolve(baseline), path.resolve(file));
} else if (import.meta.main && process.argv.includes("--worker-medium")) {
  const baseline = process.argv[process.argv.indexOf("--worker-medium") + 1];
  if (!baseline) throw new Error("Pass the pre-change Markdown module bundle after --worker-medium");
  await (await import("./scripts/bench-render")).workerMediumBench(path.resolve(baseline));
} else if (import.meta.main && process.argv.includes("--shiki-engines")) {
  await (await import("./scripts/bench-render")).shikiEngineBench();
} else if (import.meta.main && process.argv.includes("--render-sample")) {
  console.log(JSON.stringify(await renderSample()));
} else if (import.meta.main && process.argv.includes("--perf-gate")) {
  const { perfGate } = await import("./scripts/perf-gate");
  await perfGate();
} else if (import.meta.main) {
  await renderBench();
  if (process.env.SMD_BENCH_STARTUP !== "0") await startupBench();
  if (failures) {
    console.error(`\n${failures} benchmark check(s) failed`);
    process.exit(1);
  }
  console.log("\nall measured budgets met");
}

export type DriverEvent = { elapsedMs: number; data: Record<string, unknown> };

// All elapsed times originate in the parent, before spawn or before acknowledging
// a driver barrier. Neither Electron's clock nor console's printed ms is the gate.
export async function measureDriverRun(options: {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  logPath: string; timeoutMs?: number;
  onEvent?: (event: DriverEvent) => void;
}): Promise<{ events: DriverEvent[]; barriers: Record<string, number>; elapsedMs: number }> {
  const started = performance.now();
  const child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  const events: DriverEvent[] = [];
  const barriers: Record<string, number> = {};
  let output = "";
  let pending = "";
  let timedOut = false;
  let protocolError: unknown;
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    pending += chunk.toString();
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line.startsWith("smd-perf ")) continue;
      try {
        const data: unknown = JSON.parse(line.slice(9));
        if (typeof data !== "object" || data === null || Array.isArray(data) || !("kind" in data) || typeof data.kind !== "string") throw new Error("Invalid perf driver event");
        const event = { elapsedMs: performance.now() - started, data };
        events.push(event);
        if (data.kind === "barrier") {
          if (!("name" in data) || typeof data.name !== "string" || data.name in barriers) throw new Error("Invalid or duplicate perf barrier");
          barriers[data.name] = event.elapsedMs;
          child.stdin.write(data.name + "\n");
        }
        options.onEvent?.(event);
      } catch (error) { protocolError = error; child.kill("SIGTERM"); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs ?? 300_000);
  const force = setTimeout(() => child.kill("SIGKILL"), (options.timeoutMs ?? 300_000) + 3000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => { clearTimeout(timer); clearTimeout(force); fs.writeFileSync(options.logPath, output); });
  if (protocolError) throw protocolError;
  if (code !== 0 || timedOut || /driver failed|failed to open|driver eval failed/.test(output)) {
    throw new Error(`Performance driver failed: exit=${code}, timeout=${timedOut}. See ${options.logPath}`);
  }
  return { events, barriers, elapsedMs: performance.now() - started };
}

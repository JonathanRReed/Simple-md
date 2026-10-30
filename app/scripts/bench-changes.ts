import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const app = path.resolve(import.meta.dir, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "simplemd-diff-bench-"));
try {
  const built = await Bun.build({
    entrypoints: ["src/main/block-changes.ts", "src/main/render-client.ts", "src/main/render-worker.ts"].map(file => path.join(app, file)),
    outdir: directory, target: "node", format: "esm", splitting: true,
    naming: { entry: "[name].mjs", chunk: "chunks/[name]-[hash].mjs" },
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const harness = path.join(directory, "bench.mjs");
  fs.writeFileSync(harness, `
    import assert from 'node:assert/strict';
    import { calculateBlockChanges, diffSourceBlocks } from './block-changes.mjs';
    import { RenderClient } from './render-client.mjs';
    const before = Array.from({length: 2500}, (_, i) => 'Paragraph ' + i + ' with some text to verify.').join('\\n\\n').slice(0, 100000);
    const ranges = before.split('\\n\\n').map((_, i) => ({sourceRange: [i * 2, i * 2 + 1]}));
    const worker = new RenderClient();
    const direct = [], threaded = [], algorithm = [];
    try {
      await worker.warmUp();
      await worker.changes(before, before.replace('Paragraph 750 ', 'Warm edit 750 '), '/tmp/bench.md');
      for (let i = 0; i < 7; i++) {
        const after = before.replace('Paragraph 750 ', 'Edited ' + i + ' 750 ');
        let t = performance.now();
        const diff = diffSourceBlocks(before, ranges, after, ranges);
        algorithm.push(performance.now() - t);
        assert.deepEqual(diff, {changed: [[1500, 1501]], deleted: []});
        t = performance.now();
        const result = i % 2 ? await worker.changes(before, after, '/tmp/bench.md') : await calculateBlockChanges(before, after, '/tmp/bench.md');
        (i % 2 ? threaded : direct).push(performance.now() - t);
        assert.deepEqual(result, diff);
        t = performance.now();
        const other = i % 2 ? await calculateBlockChanges(before, after, '/tmp/bench.md') : await worker.changes(before, after, '/tmp/bench.md');
        (i % 2 ? direct : threaded).push(performance.now() - t);
        assert.deepEqual(other, diff);
      }
      const summary = values => { const sorted = [...values].sort((a,b) => a-b); return {samples: values, medianMs: sorted[3], minMs: sorted[0], maxMs: sorted.at(-1)}; };
      console.log(JSON.stringify({chars: before.length, blocks: ranges.length, errors: 0, algorithm: summary(algorithm), parseAndDiffInProcess: summary(direct), workerRoundTrip: summary(threaded)}, null, 2));
    } finally { await worker.dispose(); }
  `);
  const args = process.env.SMD_DIFF_PROFILE === "1" ? ["--cpu-prof", `--cpu-prof-dir=${path.resolve(app, "../.audit/m6b")}`, harness] : [harness];
  const run = spawnSync("node", args, { encoding: "utf8", timeout: 60000 });
  if (run.status !== 0) throw new Error(run.stderr || `Diff benchmark failed: ${run.status}`);
  process.stdout.write(run.stdout);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { perfFixtures } from "./perf-fixtures";

export async function workerMediumBench(baseline: string): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "simplemd-medium-"));
  try {
    const current = path.join(temp, "current.mjs");
    const built = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/main/markdown.ts")], target: "node", format: "esm" });
    if (!built.success || built.outputs.length !== 1) throw new Error(built.logs.join("\n"));
    await Bun.write(current, built.outputs[0]!);
    const fixture = path.join(temp, "medium.md");
    fs.writeFileSync(fixture, perfFixtures()["medium.md"]!);
    const runner = path.join(temp, "runner.cjs");
    fs.writeFileSync(runner, `
      const { Worker } = require('node:worker_threads');
      const fs = require('node:fs');
      const source = fs.readFileSync(${JSON.stringify(fixture)}, 'utf8');
      const workerCode = \`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { renderBlocks } = await import(workerData.module);
          const times = [];
          let count;
          let keys;
          for (let i = 0; i < 71; i++) {
            const start = performance.now();
            const result = await renderBlocks(workerData.source, workerData.file);
            times.push(performance.now() - start);
            if (!result.blocks.length || !result.blocks[0].html.includes('Perf medium')) throw Error('Wrong medium fixture');
            if (keys && keys !== JSON.stringify(result.blocks.map(b => b.key))) throw Error('Block cache changed keys');
            keys = JSON.stringify(result.blocks.map(b => b.key));
            count = result.blocks.length;
          }
          parentPort.postMessage({ first: times[0], warm: times.slice(21).reduce((a,b) => a+b, 0) / 50, blocks: count });
        })().catch(e => { throw e; });
      \`;
      async function sample(module) {
        const worker = new Worker(workerCode, { eval:true, workerData:{module,source,file:${JSON.stringify(fixture)}} });
        try { return await new Promise((resolve,reject) => { worker.once('message',resolve); worker.once('error',reject); }); }
        finally { await worker.terminate(); }
      }
      (async () => {
        const samples = {before:[], after:[]};
        for(let i=0;i<5;i++) for(const side of (i%2 ? ['after','before'] : ['before','after'])) {
          samples[side].push(await sample(side === 'before' ? ${JSON.stringify(pathToFileURL(baseline).href)} : ${JSON.stringify(pathToFileURL(current).href)}));
        }
        console.log(JSON.stringify({fixtureBytes:Buffer.byteLength(source),warmupRenders:20,warmRendersPerSample:50,loadAverage:require('node:os').loadavg(),samples}));
      })().catch(e=>{console.error(e);process.exitCode=1;});
    `);
    const child = Bun.spawn(["node", runner], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(stderr);
    console.log(stdout.trim());
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function shikiEngineBench(): Promise<void> {
  const { createHighlighter } = await import("shiki");
  const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
  const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
  const { createMarkdownParser } = await import("../src/shared/markdown-parser");
  const tokens = createMarkdownParser().parse(perfFixtures()["fences.md"]!, {}).filter((t) => t.type === "fence");
  const themes = { light: "github-light", dark: "github-dark" } as const;
  const samples: Record<string, { setup: number; render: number }[]> = { oniguruma: [], javascript: [] };
  let reference: string[] | undefined;
  for (let i = 0; i < 5; i++) {
    for (const engine of i % 2 ? ["javascript", "oniguruma"] : ["oniguruma", "javascript"]) {
      const start = performance.now();
      const h = await createHighlighter({ themes: Object.values(themes), langs: ["ts", "python"], engine: engine === "javascript" ? createJavaScriptRegexEngine() : createOnigurumaEngine(import("shiki/wasm")) });
      const setup = performance.now() - start;
      const renderStart = performance.now();
      const output = tokens.map((t) => h.codeToHtml(t.content, { lang: t.info, themes, defaultColor: false }));
      const render = performance.now() - renderStart;
      if (reference && JSON.stringify(reference) !== JSON.stringify(output)) throw new Error("Shiki engine output differs on the fence fixture");
      reference = output;
      samples[engine]!.push({ setup, render });
      h.dispose();
    }
  }
  console.log(JSON.stringify({ fences: tokens.length, samples, identicalHtml: true, loadAverage: os.loadavg() }));
}

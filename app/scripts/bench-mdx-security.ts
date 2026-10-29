import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const out = process.argv[2] ?? await fs.mkdtemp(path.join(os.tmpdir(), "smd-mdx-bench-"));
await fs.mkdir(out, { recursive: true });
const result = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/main/render-worker.ts"), path.resolve(import.meta.dir, "../src/main/render-client.ts")], outdir: out, target: "node", format: "esm", splitting: true, naming: { entry: "[name].mjs", chunk: "chunks/[name]-[hash].mjs" } });
if (!result.success) throw new Error(result.logs.join("\n"));
await fs.writeFile(path.join(out, "bench.mjs"), `
import { RenderClient } from './render-client.mjs';
const fixtures = [5000, 20000].map(n => ({name: n + '-paragraphs', source: Array.from({length:n}, (_, i) => 'Paragraph ' + i + ' with {value} here').join('\\n\\n'), count:n}));
fixtures.push({name:'5000-nested-b', source:'<b>'.repeat(5000) + 'KEEP_DEEP_CONTENT' + '</b>'.repeat(5000), count:5000});
for (const fixture of fixtures) {
  const client = new RenderClient();
  await client.warmUp();
  const start = performance.now();
  try {
    const out = await client.renderBlocks(fixture.source, '/tmp/security-bench.mdx');
    const html = out.blocks.map(b => b.html).join('');
    const correct = fixture.name.includes('paragraphs') ? (html.match(/class="mdx-expression"/g)?.length === fixture.count) : html.includes('KEEP_DEEP_CONTENT');
    console.log(JSON.stringify({name:fixture.name, bytes:Buffer.byteLength(fixture.source), ms:performance.now()-start, correct, blocks:out.blocks.length}));
  } catch(error) { console.log(JSON.stringify({name:fixture.name, bytes:Buffer.byteLength(fixture.source), ms:performance.now()-start, error:error.message})); }
  finally { await client.dispose(); }
}
`);
console.log(out);

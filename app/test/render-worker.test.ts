import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let dir: string;
let clientUrl: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-worker-test-"));
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dirname, "../src/main/render-client.ts"), path.join(import.meta.dirname, "../src/main/render-worker.ts")],
    outdir: dir,
    target: "node",
    format: "esm",
    splitting: true,
    naming: { entry: "[name].mjs", chunk: "chunks/[name]-[hash].mjs" },
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
  clientUrl = pathToFileURL(path.join(dir, "render-client.mjs")).href;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function nodeCheck(code: string): Promise<void> {
  const harness = path.join(dir, "check.mjs");
  fs.writeFileSync(harness, `
    import assert from "node:assert/strict";
    import { RenderClient } from ${JSON.stringify(clientUrl)};
    ${code}
  `);
  const child = Bun.spawn(["node", harness], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
}

function worker(name: string, code: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, code);
  return pathToFileURL(file).href;
}

describe("persistent Node render worker", () => {
  test("change parsing stays in the worker and preserves the ordinary render pipeline", async () => {
    await nodeCheck(`
      const client = new RenderClient();
      try {
        await client.warmUp();
        const before = Array.from({length: 1500}, (_, i) => 'Paragraph ' + i + ' with content.').join('\\n\\n');
        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);
        const changes = await client.changes(before, before.replace('Paragraph 750 ', 'Edited 750 '), '/tmp/changes.md');
        clearInterval(timer);
        assert.deepEqual(changes, {changed: [[1500, 1501]], deleted: []});
        assert.ok(ticks > 0, 'parent event loop ran during change parsing');
        assert.match((await client.renderBlocks('# Still works', '/tmp/changes.md')).blocks[0].html, /Still works/);
      } finally { await client.dispose(); }
    `);
  });

  test("ordinary Markdown renders without initializing YAML or KaTeX", async () => {
    const bundle = fs.readFileSync(path.join(dir, "render-worker.mjs"), "utf8");
    const chunks = [...bundle.matchAll(/import\("(\.\/chunks\/[^\"]+)"\)/g)]
      .map(match => path.join(dir, match[1]!))
      .filter(file => /node_modules\/(?:yaml|katex)\//.test(fs.readFileSync(file, "utf8")));
    expect(chunks.length).toBe(2);
    for (const file of chunks) fs.renameSync(file, `${file}.disabled`);
    try {
      await nodeCheck(`
        const client = new RenderClient();
        try {
          await client.warmUp();
          assert.match((await client.renderBlocks('# Plain', '/tmp/plain.md')).blocks[0].html, /Plain/);
          assert.match((await client.renderFragment('**Still works**', undefined)).html, /<strong>/);
        } finally { await client.dispose(); }
      `);
    } finally { for (const file of chunks) fs.renameSync(`${file}.disabled`, file); }
    await nodeCheck(`
      const client = new RenderClient();
      try {
        const out = await client.renderBlocks('---\\ntitle: Metadata\\n---\\n\\n# Math\\n\\n$E=mc^2$', '/tmp/math.md');
        assert.ok(out.blocks[0].html.includes('<th>title</th>'));
        assert.match(out.blocks.at(-1).html, /class="katex"/);
        assert.match((await client.renderFragment('> $x^2$', undefined)).html, /class="katex"/);
      } finally { await client.dispose(); }
    `);
  });

  test("plain Markdown and response validation do not initialize the MDX parser", async () => {
    const chunk = fs.readdirSync(path.join(dir, "chunks")).find(name => name.startsWith("mdx-ranges-"));
    if (!chunk) throw new Error("Missing lazy MDX parser chunk");
    const target = path.join(dir, "chunks", chunk);
    fs.renameSync(target, `${target}.disabled`);
    try {
      await nodeCheck(`
        const client = new RenderClient();
        try {
          await client.warmUp();
          assert.match((await client.renderBlocks('# Plain', '/tmp/plain.md')).blocks[0].html, /Plain/);
          await assert.rejects(client.mdxRanges('<Thing />'), /Cannot find module/);
          assert.ok((await client.renderFragment('**Still works**', undefined)).html.includes('<strong>Still works</strong>'));
        } finally { await client.dispose(); }
      `);
    } finally { fs.renameSync(`${target}.disabled`, target); }
  });

  test("renders full documents and fragments without blocking the parent event loop", async () => {
    await nodeCheck(`
      const client = new RenderClient();
      try {
        await client.warmUp();
        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);
        const source = Array.from({length: 1500}, (_, i) => '# Heading ' + i + '\\n\\nText **bold**').join('\\n\\n');
        const out = await client.renderBlocks(source, '/tmp/worker.md');
        clearInterval(timer);
        assert.equal(out.blocks.length, 3000);
        assert.deepEqual(out.blocks[0].sourceRange, [0, 1]);
        assert.deepEqual(out.blocks[1].sourceRange, [2, 3]);
        assert.ok(ticks > 0, 'parent event loop ran while the worker parsed');
        const [duplicate, fragment] = await Promise.all([
          client.renderBlocks('# Same\\n\\n# Same', '/tmp/worker.md'),
          client.renderFragment('~~~ts\\nconst n: number = 1\\n~~~', undefined),
        ]);
        assert.match(duplicate.blocks[1].html, /user-content-same-1/);
        assert.match(fragment.html, /shiki/);
        const reference = (host) => client.renderBlocks('[x][r]\\n\\n[r]: https://' + host, '/tmp/worker.md');
        await reference('before.example');
        assert.match((await reference('after.example')).blocks[0].html, /after.example/);
      } finally { await client.dispose(); }
    `);
  }, 20_000);

  test("streams a readable prefix before the deferred source and final highlights", async () => {
    await nodeCheck(`
      const client = new RenderClient();
      try {
        const source = '# First screen\\n\\n' + 'Paragraph **bold**.\\n\\n'.repeat(20000) + '\\n~~~ts\\nconst final = 42;\\n~~~';
        const first = await client.startBlocks(source, '/tmp/stream.md');
        assert.ok(first.blocks.map(b => b.html).join('').length < 20000);
        assert.ok(!first.blocks.some(b => b.html.includes('shiki')));
        let blocks = first.blocks;
        let appends = 0;
        for (;;) {
          const update = await client.nextBlocks(first.stream);
          if (update.kind === 'done') break;
          if (update.kind === 'replace') blocks = update.blocks;
          if (update.kind === 'append') { blocks.push(...update.blocks); appends++; }
          if (update.kind === 'patch') {
            const changed = new Map(update.blocks.map(b => [b.key, b]));
            blocks = blocks.map(b => changed.get(b.key) ?? b);
          }
        }
        assert.ok(appends > 1);
        const full = await client.renderBlocks(source, '/tmp/stream.md');
        assert.deepEqual(blocks.map(b => b.html), full.blocks.map(b => b.html));
        assert.ok(blocks.at(-1).html.includes('shiki'));
      } finally { await client.dispose(); }
    `);
  }, 20_000);

  test("stream completion resynchronizes deltas after an intervening full render", async () => {
    await nodeCheck(`
      const client = new RenderClient();
      try {
        const beta = await client.startBlocks('# Beta\\n\\nRetained beta.', '/tmp/beta.md');
        await client.renderBlocks('# Alpha\\n\\nExport alpha.', '/tmp/alpha.md');
        assert.equal((await client.nextBlocks(beta.stream)).kind, 'done');
        const result = await client.renderBlocks('# Beta\\n\\nRetained beta.', '/tmp/beta.md');
        assert.equal(result.blocks.length, 2);
        assert.match(result.blocks[0].html, /Beta/);
        assert.match(result.blocks[1].html, /Retained beta/);
      } finally { await client.dispose(); }
    `);
  });

  test("plain Markdown and Mermaid do not load Shiki", async () => {
    const bundle = fs.readFileSync(path.join(dir, "render-worker.mjs"), "utf8");
    const chunk = /import\("(\.\/chunks\/core-[^"]+)"\)/.exec(bundle)?.[1];
    expect(chunk).toBeDefined();
    if (!chunk) throw new Error("Missing lazy Shiki chunk");
    const target = path.join(dir, chunk);
    fs.renameSync(target, `${target}.disabled`);
    try {
      await nodeCheck(`
        const client = new RenderClient();
        try {
          await client.warmUp();
          assert.match((await client.renderBlocks('# Plain', null)).blocks[0].html, /Plain/);
          assert.match((await client.renderFragment('~~~mermaid\\ngraph LR\\nA-->B\\n~~~', undefined)).html, /class="mermaid"/);
          await assert.rejects(client.renderFragment('~~~ts\\nconst n = 1\\n~~~', undefined), /Cannot find module/);
          assert.match((await client.renderBlocks('# Recovered', null)).blocks[0].html, /Recovered/);
        } finally { await client.dispose(); }
      `);
    } finally {
      fs.renameSync(`${target}.disabled`, target);
    }
  });

  test("worker errors reject every outstanding request", async () => {
    const url = worker("crash.mjs", 'throw new Error("fixture worker crash");');
    await nodeCheck(`
      const client = new RenderClient(new URL(${JSON.stringify(url)}));
      const results = await Promise.allSettled([client.warmUp(), client.renderBlocks('# Queued', null)]);
      assert.ok(results.every((r) => r.status === 'rejected' && /fixture worker crash/.test(r.reason.message)));
      await client.dispose();
    `);
  });

  test("invalid worker responses reject requests instead of hanging", async () => {
    const url = worker("invalid.mjs", `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', () => parentPort.postMessage(null));
    `);
    await nodeCheck(`
      const client = new RenderClient(new URL(${JSON.stringify(url)}));
      await assert.rejects(client.warmUp(), /invalid response/);
      await client.dispose();
    `);
  });

  test("MDX range requests return parser positions without rendering", async () => {
    await nodeCheck(`
      const client = new RenderClient();
      try {
        const source = '# Ranges\\n\\n<Widget value={1} />';
        const result = await client.mdxRanges(source);
        assert.equal(result.error, undefined);
        assert.equal(result.ranges[0].kind, 'jsx-flow');
        assert.equal(source.slice(result.ranges[0].start, result.ranges[0].end), '<Widget value={1} />');
        assert.equal('blocks' in result, false);
        assert.ok((await client.mdxRanges(source + '{')).error);
      } finally { await client.dispose(); }
    `);
  });

  test("20000 expression paragraphs finish within the worker deadline with no lost expressions", async () => {
    await nodeCheck(`
      const client = new RenderClient();
      try {
        const source = Array.from({length:20000}, (_, i) => 'Paragraph ' + i + ' with {value} here.').join('\\n\\n');
        const result = await client.renderBlocks(source, '/tmp/security.mdx');
        assert.equal(result.blocks.length, 20000);
        assert.equal(result.blocks.map(b => b.html).join('').match(/class="mdx-expression"/g).length, 20000);
      } finally { await client.dispose(); }
    `);
  }, 35_000);

  test("clean unexpected exit also rejects requests", async () => {
    const url = worker("exit.mjs", "process.exit(0);");
    await nodeCheck(`
      const client = new RenderClient(new URL(${JSON.stringify(url)}));
      await assert.rejects(client.warmUp(), /exited with code 0/);
      await client.dispose();
    `);
  });

  test("an unresponsive worker times out and disposal rejects future calls", async () => {
    const url = worker("hang.mjs", "setInterval(() => {}, 1000);");
    await nodeCheck(`
      const client = new RenderClient(new URL(${JSON.stringify(url)}), 100);
      await assert.rejects(client.warmUp(), /timed out/);
      await client.dispose();
      await assert.rejects(client.renderBlocks('# Later', null), /disposed/);
      const pendingClient = new RenderClient(new URL(${JSON.stringify(url)}));
      const pending = [pendingClient.warmUp(), pendingClient.renderBlocks('# Queued', null)];
      const shutdown = pendingClient.dispose();
      const results = await Promise.allSettled(pending);
      await shutdown;
      assert.ok(results.every((result) => result.status === 'rejected' && /disposed/.test(result.reason.message)));
    `);
  });

  test("disposal rejects queues immediately and resolves only after the worker exits", async () => {
    const url = worker("dispose.mjs", "setInterval(() => {}, 1000);");
    await nodeCheck(`
      const { Worker } = await import('node:worker_threads');
      const terminate = Worker.prototype.terminate;
      let exits = 0;
      Worker.prototype.terminate = function () {
        this.once('exit', () => exits++);
        return terminate.call(this);
      };
      const client = new RenderClient(new URL(${JSON.stringify(url)}));
      const pending = Promise.allSettled([
        client.warmUp(), client.prefetchBlocks('# Speculative', null), client.renderBlocks('# Queued', null),
      ]);
      const shutdown = client.dispose();
      assert.ok(shutdown instanceof Promise, 'disposal returns a termination promise');
      assert.equal(client.dispose(), shutdown, 'repeated disposal shares completion');
      const results = await pending;
      assert.ok(results.every((result) => result.status === 'rejected' && /disposed/.test(result.reason.message)));
      await shutdown;
      assert.equal(exits, 1, 'disposal resolved after the owned worker exited');
      await assert.rejects(client.warmUp(), /disposed/);
      const unused = new RenderClient();
      await unused.dispose();
      assert.equal(exits, 1, 'disposing an unused client does not create a worker');
    `);
  });

  test("keeps one speculative slot and gives queued user requests priority", async () => {
    const url = worker("ordering.mjs", `
      import { parentPort } from 'node:worker_threads';
      let order = 0;
      parentPort.on('message', (request) => setTimeout(() => parentPort.postMessage({
        id: request.id, kind: 'blocks', value: { title: request.text, blocks: [{ key: String(++order), html: request.text, urls: {}, sourceRange: [0, 1] }] }
      }), 10));
    `);
    await nodeCheck(`
      const client = new RenderClient(new URL(${JSON.stringify(url)}));
      try {
        const active = client.renderBlocks('active', null);
        const stale = client.prefetchBlocks('stale', null);
        const latest = client.prefetchBlocks('latest', null);
        const foreground = client.renderBlocks('foreground', null);
        assert.equal(await stale, null);
        assert.equal((await active).blocks[0].key, '1');
        assert.equal((await foreground).blocks[0].key, '2');
        assert.equal((await latest).blocks[0].key, '3');
        assert.equal(await client.prefetchBlocks('x'.repeat(256 * 1024 + 1), null), null);
      } finally { await client.dispose(); }
    `);
  });
});

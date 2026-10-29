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

  test("plain Markdown and Mermaid do not load Shiki", async () => {
    const bundle = fs.readFileSync(path.join(dir, "render-worker.mjs"), "utf8");
    const chunk = /import\("(\.\/chunks\/index-[^"]+)"\)/.exec(bundle)?.[1];
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

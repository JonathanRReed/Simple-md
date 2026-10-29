import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDocument, writeAtomic } from "../src/main/files";
import { embedLocalImages } from "../src/main/export-html";
import { resolveAuthorUrl } from "../src/shared/url-resolver";
import { isRenderNode, type RenderNode } from "../src/shared/render-tree";
import { createRenderCore } from "../src/shared/render-core";

const dirs: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smd-security-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

test("relative resources and links cannot climb out of their allowed folder", () => {
  for (const kind of ["resource", "anchor"] as const) {
    const context = { baseUrl: "file:///project/docs/", rootUrl: "file:///project/" };
    for (const url of ["../../secret.md", "../../project-other/secret.md", "%2e%2e/%2e%2e/secret.md"]) {
      expect(resolveAuthorUrl(url, kind, context)).toBeNull();
    }
    expect(resolveAuthorUrl("../secret.md", kind, { baseUrl: context.baseUrl })).toBeNull();
    expect(resolveAuthorUrl("/image.png", kind, { baseUrl: context.baseUrl })).toBe("file:///project/docs/image.png");
  }
});

test("export skips missing, unsupported and escaped symlink images", async () => {
  const dir = await fixture();
  const root = path.join(dir, "project");
  await fs.mkdir(root);
  const outside = path.join(dir, "secret.png");
  await fs.writeFile(outside, "PRIVATE");
  await fs.symlink(outside, path.join(root, "escape.png"));
  await fs.writeFile(path.join(root, "image.tiff"), "TIFF");
  const sources = ["escape.png", "missing.png", "image.tiff"].map(name => pathToFileURL(path.join(root, name)).href);
  // The URL context is required for realpath containment by the fixed exporter.
  const embedded = await embedLocalImages(sources, file => fs.readFile(file), { baseUrl: pathToFileURL(root + path.sep).href });
  expect(embedded).toEqual(sources);
});

for (const special of ["fifo", "zero", "directory"]) {
  test.skipIf(process.platform === "win32")(`${special} document fails fast without blocking the next read`, async () => {
    const dir = await fixture();
    const file = path.join(dir, "x.md");
    if (special === "fifo") expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
    else if (special === "zero") await fs.symlink("/dev/zero", file);
    else await fs.mkdir(file);
    const regular = path.join(dir, "ok.md");
    await fs.writeFile(regular, "still readable");
    const script = path.join(dir, "read.ts");
    await fs.writeFile(script, `import { readDocument } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/main/files.ts"))};
      try { await readDocument(${JSON.stringify(file)}); process.exit(2); }
      catch(error) { if (!/regular file/i.test(error.message)) throw error; }
      if ((await readDocument(${JSON.stringify(regular)})).text !== 'still readable') process.exit(3);`);
    const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    try {
      const exit = await child.exited;
      const error = await new Response(child.stderr).text();
      expect({ exit, error }).toEqual({ exit: 0, error: "" });
    } finally { clearTimeout(timer); }
  });
}

test.skipIf(process.platform !== "darwin")("immutable files open read-only and refuse saves without locked temp files", async () => {
  const dir = await fixture();
  const file = path.join(dir, "locked.md");
  await fs.writeFile(file, "protected");
  expect(Bun.spawnSync(["chflags", "uchg", file]).exitCode).toBe(0);
  try {
    expect((await readDocument(file)).readOnlyReason).toMatch(/read.only/i);
    await expect(writeAtomic(file, "replacement")).rejects.toThrow(/read.only/i);
    expect(await fs.readdir(dir)).toEqual(["locked.md"]);
    expect(await fs.readFile(file, "utf8")).toBe("protected");
  } finally {
    for (const name of await fs.readdir(dir)) Bun.spawnSync(["chflags", "nouchg", path.join(dir, name)]);
  }
});

test("iterative tree validation accepts deep content and rejects cycles", () => {
  let node: RenderNode = { kind: "app", parts: ["KEEP_DEEP_CONTENT"] };
  for (let i = 0; i < 5000; i++) node = { kind: "author", parts: [node] };
  expect(isRenderNode(node)).toBe(true);
  const cycle: RenderNode = { kind: "app", parts: [] };
  cycle.parts.push(cycle);
  expect(isRenderNode(cycle)).toBe(false);
});

test("5000 nested JSX elements retain their deepest content", async () => {
  const source = "<b>".repeat(5000) + "KEEP_DEEP_CONTENT" + "</b>".repeat(5000);
  const rendered = await createRenderCore().renderMarkdown(source, "/tmp/nested.mdx");
  expect(rendered.html).toContain("KEEP_DEEP_CONTENT");
}, 30_000);

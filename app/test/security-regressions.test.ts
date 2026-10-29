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
  const warnings: string[] = [];
  const embedded = await embedLocalImages(sources, { baseUrl: pathToFileURL(root + path.sep).href }, message => warnings.push(message));
  expect(embedded).toEqual(sources);
  expect(warnings).toHaveLength(3);
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

test("documents and export images enforce their byte limits", async () => {
  const dir = await fixture();
  const document = path.join(dir, "large.md");
  const image = path.join(dir, "large.png");
  await fs.writeFile(document, "");
  await fs.truncate(document, 64 * 1024 * 1024 + 1);
  await expect(readDocument(document)).rejects.toThrow("64 MB read limit");
  await fs.writeFile(image, "");
  await fs.truncate(image, 25 * 1024 * 1024 + 1);
  const source = pathToFileURL(image).href;
  const warnings: string[] = [];
  expect(await embedLocalImages([source], { baseUrl: pathToFileURL(dir + path.sep).href }, warning => warnings.push(warning))).toEqual([source]);
  expect(warnings[0]).toContain("25 MB read limit");
});

test.skipIf(process.platform !== "darwin")("metadata copy never propagates immutable BSD flags", async () => {
  const { copyMetadata } = await import("../src/main/file-metadata");
  const dir = await fixture();
  const source = path.join(dir, "source.md");
  const target = path.join(dir, "target.tmp");
  await fs.writeFile(source, "source");
  await fs.writeFile(target, "");
  expect(Bun.spawnSync(["chflags", "uchg", source]).exitCode).toBe(0);
  try {
    await copyMetadata(source, target);
    await fs.writeFile(target, "writable");
    expect(await fs.readFile(target, "utf8")).toBe("writable");
  } finally {
    Bun.spawnSync(["chflags", "nouchg", source, target]);
  }
});

test.skipIf(process.platform === "win32")("a FIFO image is skipped without blocking the remaining export", async () => {
  const dir = await fixture();
  const fifo = path.join(dir, "pipe.png");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const image = path.join(dir, "ok.png");
  await fs.writeFile(image, Buffer.from([1, 2, 3]));
  const sources = [fifo, image].map(file => pathToFileURL(file).href);
  const warnings: string[] = [];
  const embedded = await embedLocalImages(sources, { baseUrl: pathToFileURL(dir + path.sep).href }, warning => warnings.push(warning));
  expect(embedded).toEqual([sources[0], "data:image/png;base64,AQID"]);
  expect(warnings[0]).toContain("regular files");
});

test.skipIf(process.platform === "win32")("an author-controlled Astro public symlink cannot grant an outside root", async () => {
  const { urlContext } = await import("../src/main/document-urls");
  const dir = await fixture();
  const project = path.join(dir, "project");
  const outside = path.join(dir, "private");
  await fs.mkdir(project);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(project, "astro.config.mjs"), "");
  await fs.symlink(outside, path.join(project, "public"));
  const context = urlContext(project);
  expect(context.rootUrl).toBeUndefined();
  const source = pathToFileURL(path.join(project, "public/secret.png")).href;
  await fs.writeFile(path.join(outside, "secret.png"), "PRIVATE");
  const warnings: string[] = [];
  expect(await embedLocalImages([source], context, warning => warnings.push(warning))).toEqual([source]);
  expect(warnings).toHaveLength(1);
});

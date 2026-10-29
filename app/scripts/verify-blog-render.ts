// Read-only source qualification. All app opens use byte-identical temporary copies.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import electron from "electron";
import type { DriverStep } from "../src/main/driver";

const sourceRoot = process.argv[2] ?? "/Users/jonathanreed/Downloads/Personal-Site";
const sourceDir = path.join(sourceRoot, "src/content/blog");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "simplemd-blog-"));
const appRoot = path.resolve(import.meta.dir, "..");
const site = path.join(root, "site");
const copies = path.join(site, "src/content/blog");
fs.mkdirSync(copies, { recursive: true });
fs.writeFileSync(path.join(site, "astro.config.mjs"), "// Resolver qualification fixture.\n");
fs.symlinkSync(path.join(sourceRoot, "public"), path.join(site, "public"), "dir");
const posts = fs.readdirSync(sourceDir).filter((name) => name.endsWith(".mdx")).sort();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const originals = new Map(posts.map((name) => [name, hash(fs.readFileSync(path.join(sourceDir, name)))]));
const inputs = posts.map((name) => {
  const source = fs.readFileSync(path.join(sourceDir, name), "utf8");
  const file = path.join(copies, name);
  fs.writeFileSync(file, fs.readFileSync(path.join(sourceDir, name)));
  return { name, file, expectedDetails: (source.match(/<details(?:\s|>)/g) ?? []).length, expectedFigures: (source.match(/<figure(?:\s|>)/g) ?? []).length,
    captions: [...source.matchAll(/<figcaption>([\s\S]*?)<\/figcaption>/g)].map((match) => match[1]!.replace(/\s+/g, " ").trim()),
    expectedHtmlImages: (source.match(/<img(?:\s|>)/g) ?? []).length,
    rootImages: [...source.matchAll(/<img\b[\s\S]*?>/gi)].flatMap((tag) => [...tag[0].matchAll(/\bsrc\s*=\s*["'](\/[^"']+)["']/g)].map((m) => m[1]!)) };
});
const steps: DriverStep[] = [];
for (const input of inputs) {
  steps.push({ record: { name: input.name, eval: `(async () => {
    const input = ${JSON.stringify(input)};
    const deadline = Date.now() + 15000;
    const wait = async (test) => { while (!test()) { if (Date.now() > deadline) throw Error('Blog render timed out: ' + input.name); await new Promise(r => setTimeout(r, 30)); } };
    if (document.documentElement.dataset.documentPath !== input.file) await window.simplemd.openPath(input.file, 'peek');
    await wait(() => document.documentElement.dataset.firstReadable === input.file && !document.querySelector('#edit').inert);
    const doc = document.querySelector('#doc');
    const images = [...doc.querySelectorAll('img')];
    await Promise.all(images.map(async image => {
      if (!image.complete) await Promise.race([new Promise(r => { image.addEventListener('load', r, {once:true}); image.addEventListener('error', r, {once:true}); }), new Promise(r => setTimeout(r, 5000))]);
    }));
    const result = { ...input, details: doc.querySelectorAll('details:not(.frontmatter)').length, summaries: doc.querySelectorAll('details:not(.frontmatter) > summary').length,
      figures: doc.querySelectorAll('figure').length, captionsShown: input.captions.filter(caption => doc.textContent.replace(/\\s+/g, ' ').includes(caption)).length,
      images: images.map(image => ({src: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0})),
      active: doc.querySelectorAll('script, style, iframe, [onerror], [onclick], [onload]').length };
    if (result.details !== input.expectedDetails || result.active || images.length < input.expectedHtmlImages) throw Error('Blog DOM mismatch: ' + JSON.stringify(result));
    if (result.captionsShown !== input.captions.length || result.images.some(image => !image.loaded)) throw Error('Blog caption or image missing: ' + JSON.stringify(result));
    if (input.rootImages.some(src => !images.some(image => image.src.includes('/site/public' + src)))) throw Error('Astro image root mismatch: ' + input.name);
    return result;
  })()` } });
}
steps.push({ shot: path.join(root, "last-blog.png") }, { quit: true });
const drive = path.join(root, "driver.json");
fs.writeFileSync(drive, JSON.stringify(steps));
const profile = path.join(root, "profile");
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ mode: "source", autosave: false, spacePreview: false, launchAtLogin: false, peekPrompted: true }));
const env = { ...process.env, SMD_USER_DATA: profile, SMD_DRIVE: drive, SMD_INTENT: "peek", SMD_TRACE: "1" };
delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
const child = Bun.spawn([String(electron), path.join(appRoot, "dist/main.mjs"), inputs[0]!.file], { cwd: appRoot, env, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(180_000) });
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
fs.writeFileSync(path.join(root, "app.log"), stdout + stderr);
assert.equal(code, 0, `Blog app driver failed. See ${root}/app.log`);
const results = stdout.split("\n").filter((line) => line.startsWith("smd-perf ")).map((line) => JSON.parse(line.slice(9))).filter((event) => event.kind === "record").map((event) => event.value);
assert.equal(results.length, posts.length);
for (const name of posts) {
  assert.equal(hash(fs.readFileSync(path.join(sourceDir, name))), originals.get(name), "Original blog source changed");
  assert.equal(hash(fs.readFileSync(path.join(copies, name))), originals.get(name), "Temporary blog copy changed");
}
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify({ sourceRoot, originalsUnchanged: true, copiesUnchanged: true, results }, null, 2));
console.log(`Blog render: ${results.length} posts. Results: ${root}/results.json`);

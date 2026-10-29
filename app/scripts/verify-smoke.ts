import { assertDocument as assertPerfDocument } from "./perf-gate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DriverStep } from "../src/main/driver";

type Step = DriverStep;
type Result = { name: string; status: "passed" } | { name: string; status: "failed"; error: string };
type DiskChange = { marker: string; file: string; text: string; preserveTimes?: boolean };

const appRoot = path.resolve(import.meta.dir, "..");
const dist = path.join(appRoot, "dist");
const executable = path.join(appRoot, "node_modules/electron/dist", fs.readFileSync(path.join(appRoot, "node_modules/electron/path.txt"), "utf8").trim());
const bundled = fs.readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".mjs"));
assert(bundled.some((file) => fs.readFileSync(path.join(dist, file), "utf8").includes("SMD_USER_DATA")), "Build the app with the isolated SMD_USER_DATA contract before running smoke tests.");
assert(fs.existsSync(executable), "Local Electron executable is missing.");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-md-smoke-"));
const results: Result[] = [];
const filter = process.argv[2];
const quote = JSON.stringify;
const mod = process.platform === "darwin" ? "meta" : "control";

function evaluate(code: string): Step {
  return { eval: `(async () => {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const waitFor = async (predicate, message, timeoutMs = 10000) => {
      const deadline = performance.now() + timeoutMs;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const editorText = () => [...document.querySelectorAll('.cm-content .cm-line')].map(line => line.textContent).join('\\n');
    ${code}
  })()` };
}

function appendCharacter(char: string): Step[] {
  return [
    evaluate("await waitFor(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true', 'Editor stayed frozen.'); document.querySelector('.cm-content').focus();"),
    { input: { type: "keyDown", keyCode: "A", modifiers: [mod] } },
    { input: { type: "keyUp", keyCode: "A", modifiers: [mod] } },
    { input: { type: "keyDown", keyCode: "Right" } },
    { input: { type: "keyUp", keyCode: "Right" } },
    { input: { type: "char", keyCode: char } },
    evaluate(`await waitFor(() => editorText().endsWith(${quote(char)}), 'Typed character did not reach CodeMirror.');
      await waitFor(() => !document.querySelector('#dirty').hidden, 'Typing did not mark the note dirty.');`),
  ];
}

function fixture(name: string, text: string): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

async function launch(name: string, file: string, steps: Step[], intent: "read" | "edit" = "read", change?: DiskChange, expectedExit: 0 | 1 = 0, initialMode: "source" | "split" | "live" = "source"): Promise<void> {
  const output = path.join(root, name);
  const profile = path.join(output, "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
    mode: initialMode, autosave: false, launchAtLogin: false,
  }));
  const done = path.join(output, "done.png");
  const drive = path.join(output, "drive.json");
  const last = steps.at(-1);
  const sequence = last && "menuQuit" in last ? [...steps.slice(0, -1), { shot: done }, last] : [...steps, { shot: done }];
  fs.writeFileSync(drive, JSON.stringify(sequence, null, 2));
  const env: NodeJS.ProcessEnv = { ...process.env, SMD_USER_DATA: profile, SMD_DRIVE: drive, SMD_INTENT: intent, SMD_TRACE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let logs = "";
  let injected = false;
  let mutationError: unknown;
  const poll = change && setInterval(() => {
    if (!fs.existsSync(change.marker)) return;
    clearInterval(poll);
    try {
      const temporary = `${change.file}.external`;
      const stat = fs.statSync(change.file);
      fs.writeFileSync(temporary, change.text);
      if (change.preserveTimes) fs.utimesSync(temporary, stat.atime, stat.mtime);
      fs.renameSync(temporary, change.file);
      if (change.preserveTimes) {
        const replaced = fs.statSync(change.file);
        assert.equal(replaced.mtimeMs, stat.mtimeMs, "Cache fixture did not preserve mtime.");
        assert.equal(replaced.size, stat.size, "Cache fixture did not preserve size.");
      }
      injected = true;
    } catch (error) {
      mutationError = error;
    }
  }, 20);
  try {
    const child = spawn(executable, [appRoot, file], { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (data: Buffer) => { logs = (logs + String(data)).slice(-1_000_000); });
    child.stderr.on("data", (data: Buffer) => { logs = (logs + String(data)).slice(-1_000_000); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
    const forceTimeout = setTimeout(() => child.kill("SIGKILL"), 93_000);
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      clearTimeout(timeout);
      clearTimeout(forceTimeout);
      fs.writeFileSync(path.join(output, "electron.log"), logs);
    }
    fs.writeFileSync(path.join(output, "exit.json"), JSON.stringify({ ...exit, expectedExit }, null, 2));
    assert.equal(exit.code, expectedExit, `Electron exited with code ${exit.code}, signal ${exit.signal}; expected ${expectedExit}.\n${logs}`);
    if (expectedExit !== 0) {
      assert(!fs.existsSync(done), "Driver continued after the deliberate assertion failure.");
      assert(logs.includes("SMOKE_EXPECTED_DRIVER_FAILURE"), "Electron failed for an unrelated reason.");
      return;
    }
    assert(fs.existsSync(done), `Driver did not finish all assertions.\n${logs}`);
    assert(fs.statSync(done).size > 100, "Completion screenshot is empty.");
    if (mutationError) throw mutationError;
    if (change) assert(injected, "External-change fixture was not written.");
  } finally {
    if (poll) clearInterval(poll);
  }
}

async function test(name: string, run: () => Promise<void>): Promise<void> {
  if (filter && !name.includes(filter)) return;
  try {
    await run();
    results.push({ name, status: "passed" });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "failed", error: message });
    console.error(`FAIL ${name}\n${message}`);
  }
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const note = "# Smoke edit note\n\nOriginal text.\n";

await test("normal-read-window", async () => {
  const file = fixture("normal-read-window/note.md", note);
  await launch("normal-read-window", file, [
    evaluate(`assert(document.querySelector('#edit').hidden, 'Read intent opened the editor.');
      const settings = (await window.simplemd.ready()).settings;
      for (const key of ['shortcut', 'spacePreview', 'peekPrompted']) assert(!(key in settings), 'Obsolete setting remains: ' + key);
      let rejected = false;
      try { await window.simplemd.openPath(${quote(file)}, 'peek'); } catch { rejected = true; }
      assert(rejected, 'Removed peek intent was accepted.');`),
    { input: { type: "keyDown", keyCode: "Space" } },
    { input: { type: "keyUp", keyCode: "Space" } },
    { wait: 100 },
    { visibility: true },
    { input: { type: "keyDown", keyCode: "Escape" } },
    { input: { type: "keyUp", keyCode: "Escape" } },
    { wait: 100 },
    { visibility: true },
    evaluate(`assert(document.querySelector('#edit').hidden, 'Dismiss keys changed the reading view.');`),
  ]);
});

await test("live-open-defers-read-render", async () => {
  const file = fixture("live-open/note.md", note);
  const previous = process.env.SMD_PERF;
  process.env.SMD_PERF = "1";
  try {
    await launch("live-open-defers-read-render", file, [
      evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(file)}, 'Live document did not paint.');
        assert(document.querySelector('#edit').dataset.mode === 'live', 'Live mode did not initialize.');
        assert(document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === ${quote(note)}, 'Live source differs.');`),
      { record: { name: "live-ready", eval: "true" } },
      evaluate(`window.simplemd.command('toggle-edit');
        await waitFor(() => !document.querySelector('#read').hidden && document.querySelector('#doc h1')?.textContent === 'Smoke edit note', 'Read view did not render after Live.');`),
    ], "edit", undefined, 0, "live");
  } finally {
    if (previous === undefined) delete process.env.SMD_PERF;
    else process.env.SMD_PERF = previous;
  }
  const logs = fs.readFileSync(path.join(root, "live-open-defers-read-render/electron.log"), "utf8");
  const ready = logs.indexOf('"name":"live-ready"');
  assert(ready >= 0, "Missing Live readiness record.");
  assert(!logs.slice(0, ready).includes('"marker":"parse-start"'), "Live initialized an unused full-document render.");
  assert(!logs.slice(0, ready).includes('"marker":"worker-queue"'), "Live started an unused render worker.");
  assert(logs.slice(ready).includes('"marker":"parse-start"'), "Read did not request its render.");
  assert.equal(fs.readFileSync(file, "utf8"), note, "Live-to-read changed the source bytes.");
});

await test("quit-with-late-renderer-markers", async () => {
  const file = fixture("late-markers/first.md", "# First\n");
  const target = fixture("late-markers/second.md", "# Second\n\nA complete read view.\n");
  const previous = process.env.SMD_PERF;
  process.env.SMD_PERF = "1";
  try {
    await launch("quit-with-late-renderer-markers", file, [
      evaluate(`window.simplemd.onDoc(payload => { window.smokeQuitDocumentId = payload.documentId; });
        assert(await window.simplemd.openPath(${quote(target)}, 'read'), 'Second document did not open.');
        await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(target)}, 'Second document did not paint.');
        window.setInterval(() => window.simplemd.perfMarker(window.smokeQuitDocumentId, 'diagrams-ready'), 1);`),
      { menuQuit: true },
    ]);
  } finally {
    if (previous === undefined) delete process.env.SMD_PERF;
    else process.env.SMD_PERF = previous;
  }
  const logs = fs.readFileSync(path.join(root, "quit-with-late-renderer-markers/electron.log"), "utf8");
  assert(logs.includes("quit-worker-stopped"), "Quit did not finish worker cleanup.");
  assert(!logs.includes("TypeError"), "Late markers reached the disposed document registry.");
});

await test("driver-assertion-failure", async () => {
  const file = fixture("driver-check/note.md", note);
  await launch("driver-assertion-failure", file, [
    { assert: "false /* SMOKE_EXPECTED_DRIVER_FAILURE */" },
  ], "read", undefined, 1);
  assert.equal(fs.readFileSync(file, "utf8"), note, "Failed driver changed its source note.");
});

await test("security-links", async () => {
  const file = fixture("security-links/project/note.md", '# Contained links\n\n[Outside](../../outside.md)\n\n![Outside](../../outside.png)\n');
  fs.mkdirSync(path.join(path.dirname(file), ".git"));
  const outside = fixture("security-links/outside.md", "# PRIVATE");
  const escape = path.join(path.dirname(file), "escape.md");
  fs.symlinkSync(outside, escape);
  await launch("security-links", file, [evaluate(`
    await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Contained links', 'Security note did not render.');
    assert(!document.querySelector('#doc a[href]'), 'Climbing link is active.');
    assert(!document.querySelector('#doc img').hasAttribute('src'), 'Climbing image has a URL.');
    assert(await window.simplemd.openLink(${quote('file://' + outside)}) === false, 'Cmd-click file link escaped the root.');
    assert(await window.simplemd.openLink(${quote('file://' + escape)}) === false, 'Symlink link escaped the root.');
    assert(document.querySelector('#doc h1').textContent === 'Contained links', 'Refused link changed the document.');
  `)]);
});

await test("streamed-large-export", async () => {
  const source = '# Full streamed export\n\n' + 'A paragraph with **bold** text. '.repeat(20).concat('\n\n').repeat(600) + '## Final export sentinel\n';
  const file = fixture('streamed-large-export/note.md', source);
  const html = path.join(root, 'streamed-large-export/output.html');
  await launch('streamed-large-export', file, [
    evaluate(`await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Full streamed export', 'Readable prefix did not arrive.');`),
    { html },
  ]);
  assert(fs.readFileSync(html, 'utf8').includes('Final export sentinel'), 'Export stopped at the readable prefix.');
  assert.equal(fs.readFileSync(file, 'utf8'), source, 'Streaming export changed the source.');
});

await test("security-export", async () => {
  const file = fixture("security-export/project/note.md", '# Export containment\n\n[Local](next.md)\n\n<picture><source srcset="pixel.png 1x"><img src="pixel.png"></picture>\n\n![Missing](missing.png)\n\n![Unsupported](image.tiff)\n\n![Escape](escape.png)\n');
  const dir = path.dirname(file);
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "pixel.png"), png);
  fs.writeFileSync(path.join(dir, "image.tiff"), "unsupported");
  const secret = fixture("security-export/private.png", "PRIVATE_IMAGE_BYTES");
  fs.symlinkSync(secret, path.join(dir, "escape.png"));
  const html = path.join(root, "security-export/output.html");
  await launch("security-export", file, [evaluate(`
    await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Export containment', 'Export note did not render.');
    await waitFor(() => document.querySelector('#doc picture img')?.naturalWidth > 0, 'Local srcset image did not load.');
  `), { html }]);
  const exported = fs.readFileSync(html, "utf8");
  assert(!exported.includes('file:'), 'Export leaked absolute local URLs.');
  assert(exported.includes('data:image/png;base64,' + png.toString('base64')), 'Local srcset candidate was not embedded.');
  assert(!exported.includes(Buffer.from('PRIVATE_IMAGE_BYTES').toString('base64')), 'Export read a symlink outside the root.');
  const logs = fs.readFileSync(path.join(root, 'security-export/electron.log'), 'utf8');
  assert(logs.includes('skipped export image'), 'Skipped images did not produce warnings.');
});

await test("split-prepared-blocks", async () => {
  const file = fixture("split-prepared-blocks/note.md", "# Prepared split\n\nReadable preview.\n");
  await launch("split-prepared-blocks", file, [
    evaluate(`assert(document.querySelector('#edit').dataset.mode === 'split', 'Side by side did not initialize.');
      assert(document.querySelector('#preview h1')?.textContent === 'Prepared split', 'Prepared blocks did not mount.');
      assert(document.querySelector('.cm-content'), 'The source editor did not mount.');`),
  ], "edit", undefined, 0, "split");
  const logs = fs.readFileSync(path.join(root, "split-prepared-blocks/electron.log"), "utf8");
  assert(!logs.includes("render-done"), "Side by side initialization requested a second full render.");
});

await test("mdx-ranges-only", async () => {
  const file = fixture("mdx-ranges-only/note.mdx", '# Ranges only\n\n<Widget value={1} />\n');
  await launch("mdx-ranges-only", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content'), 'Source MDX did not open.');
      await window.simplemd.setSettings({ mode: 'live' });
      assert(await window.simplemd.openPath(${quote(file)}, 'edit'), 'Live MDX did not reopen.');
      window.simplemd.command('mode-source');`),
    ...appendCharacter('!'),
    { wait: 500 },
    evaluate("window.simplemd.command('mode-live');"),
    ...appendCharacter('?'),
    { wait: 500 },
  ], "edit");
  const logs = fs.readFileSync(path.join(root, 'mdx-ranges-only/electron.log'), 'utf8');
  assert((logs.match(/doc-sent name=note.mdx blocks=0 intent=edit/g) ?? [] ).length === 1, 'Focusing existing MDX reopened or fully rendered it.');
  assert(logs.split('mdx-ranges-done').length >= 3, 'Source and Live did not request ranges.');
  assert(!logs.includes('render-done'), 'Source or Live requested a full MDX render.');
});

await test("render-links-pdf", async () => {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const source = "# Smoke render alpha\n\n## [Introduction](https://example.com)\n\n[Jump](#introduction)\n\n![image](image%20%231.png)\n\n[Next](../beta/note%20%231.md#target-section)\n\n```ts\nconst smoke = 42;\n```\n\nInline $E=mc^2$.\n\n```mermaid\ngraph LR\nStart-->Finish\n```\n\n<script>window.smokeInjected = true</script>\n\n[unsafe](javascript:alert(1))\n";
  const alpha = fixture("alpha/note.md", source);
  const beta = fixture("beta/note #1.md", "# Smoke render beta\n\n![image](image%20%231.png)\n\n" + "Before the target.\n\n".repeat(40) + "## Target section\n\n" + "After the target.\n\n".repeat(30));
  fs.writeFileSync(path.join(root, "alpha/image #1.png"), png);
  fs.writeFileSync(path.join(root, "beta/image #1.png"), png);
  const pdf = path.join(root, "render-links-pdf/output.pdf");
  const html = path.join(root, "render-links-pdf/output.html");
  await launch("render-links-pdf", alpha, [
    evaluate(`await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render alpha', 'Initial note did not render.');
      assert(document.documentElement.dataset.firstReadable === ${quote(alpha)}, 'First-readable marker is missing.');
      assert(document.querySelector('#edit').hidden, 'Reading view opened an editor.');
      await waitFor(() => document.querySelector('#doc .shiki'), 'Shiki code did not render.');
      assert(document.querySelector('#doc .katex'), 'KaTeX did not render.');
      assert(document.querySelector('#doc #user-content-introduction'), 'Linked heading has no matching fragment target.');
      await waitFor(() => document.querySelector('#doc .diagram svg'), 'Pele diagram did not render.');
      await waitFor(() => document.querySelector('#doc img')?.naturalWidth > 0, 'Relative image with a hash in its filename did not load.');
      assert(!document.querySelector('#doc script, #doc [onerror]'), 'Raw HTML became active DOM.');
      assert(!window.smokeInjected, 'Raw Markdown script executed.');
      assert(!document.querySelector('#doc a[href^="javascript:"]'), 'Unsafe link became clickable.');
      assert(typeof window.require === 'undefined', 'Renderer has Node require.');
      await waitFor(() => !document.querySelector('#read').inert && !document.querySelector('#edit').inert && document.documentElement.dataset.documentPainted === ${quote(alpha)}, 'Initial note transition did not finish.', 30000);
      document.querySelector('#doc a[href*="note%20%231.md"]').click();
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render beta' && document.documentElement.dataset.documentPainted === ${quote(beta)} && !document.querySelector('#read').inert && !document.querySelector('#edit').inert, 'Encoded Markdown link did not commit.', 30000);
      await waitFor(() => document.querySelector('#read-scroll').scrollTop > 500, 'Cross-file fragment did not scroll.');
      const targetTop = document.querySelector('#doc #user-content-target-section').getBoundingClientRect().top;
      const viewport = document.querySelector('#read-scroll').getBoundingClientRect();
      assert(targetTop >= viewport.top && targetTop < viewport.top + 100, 'Cross-file heading is not at the viewport start.');
      await waitFor(() => document.querySelector('#doc img')?.naturalWidth > 0, 'Image did not resolve after navigation.');
      assert(document.querySelector('#doc img').src.includes('/beta/'), 'Navigation kept the previous image base path.');
      window.simplemd.command('nav-back');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render alpha' && !document.querySelector('#edit').inert, 'Back navigation failed.');
      window.simplemd.command('nav-forward');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render beta' && !document.querySelector('#edit').inert, 'Forward navigation failed.');
      window.simplemd.command('nav-back');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render alpha' && !document.querySelector('#edit').inert, 'Return to export note failed.');`),
    { pdf },
    { html },
  ]);
  assert.equal(fs.readFileSync(alpha, "utf8"), source, "Reading or navigation changed the source note.");
  assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), "%PDF-", "PDF output is invalid.");
  const pdftotext = Bun.which("pdftotext");
  assert(pdftotext, "Install pdftotext to verify PDF content. The smoke does not treat a PDF header as rendering proof.");
  const extracted = Bun.spawnSync([pdftotext, pdf, "-"]);
  assert.equal(extracted.exitCode, 0, "PDF text extraction failed.");
  const text = extracted.stdout.toString();
  assert(text.includes("Smoke render alpha") && text.includes("smoke") && text.includes("Start") && text.includes("Finish"), "PDF is missing note, code or diagram content.");
  const pdfimages = Bun.which("pdfimages");
  assert(pdfimages, "pdfimages is required to verify the exported local image.");
  const images = Bun.spawnSync([pdfimages, "-list", pdf]);
  assert.equal(images.exitCode, 0, "PDF image inspection failed.");
  assert(/^\s*\d+\s+\d+\s+image\s+/m.test(images.stdout.toString()), "PDF omitted the local image.");
  const exported = fs.readFileSync(html, "utf8");
  assert(exported.includes("Smoke render alpha") && exported.includes("shiki") && exported.includes("katex"), "HTML omitted rendered note content.");
  assert(/<svg\b/.test(exported) && !/<pre class="mermaid"/.test(exported), "HTML retained Mermaid source instead of its SVG.");
  assert(exported.includes(`data:image/png;base64,${png.toString("base64")}`), "HTML did not embed the exact local image bytes.");
  assert(!/\bsrc=["']file:/i.test(exported), "HTML still depends on local image paths.");
  assert(!exported.includes("url(fonts/") && /url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)/.test(exported), "HTML font embedding is incomplete.");
  assert(!/<script\b/i.test(exported), "Static HTML export contains an active script.");
});

await test("github-theme-images", async () => {
  const name = "github-theme-images";
  fixture(`${name}/dark.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"><rect width="13" height="13" fill="black"/></svg>');
  fixture(`${name}/light.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17"><rect width="17" height="17" fill="white"/></svg>');
  const source = '# Theme images\n\n<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"><source media="(prefers-color-scheme: light)" srcset="light.svg"><img src="light.svg" alt="picture"></picture>\n\n![dark](dark.svg#gh-dark-mode-only) ![light](light.svg#gh-light-mode-only)\n';
  const file = fixture(`${name}/note.md`, source);
  await launch(name, file, [evaluate(`
    await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(file)}, 'Theme fixture did not open.');
    for (const theme of ['light', 'dark', 'light']) {
      await window.simplemd.setSettings({ theme });
      await waitFor(() => document.documentElement.dataset.theme === theme, 'App theme did not update.');
      const picture = document.querySelector('#doc picture img');
      await waitFor(() => picture.currentSrc.endsWith('/' + theme + '.svg') && picture.naturalWidth === (theme === 'dark' ? 13 : 17), 'Picture did not load the app theme source.');
      assert((getComputedStyle(document.querySelector('#doc img[alt="dark"]')).display !== 'none') === (theme === 'dark'), 'Dark fragment visibility disagrees with app theme.');
      assert((getComputedStyle(document.querySelector('#doc img[alt="light"]')).display !== 'none') === (theme === 'light'), 'Light fragment visibility disagrees with app theme.');
    }
  `)]);
  assert.equal(fs.readFileSync(file, "utf8"), source, "Theme changes changed the source note.");
});

await test("author-html", async () => {
  fixture("author/site/astro.config.mjs", "");
  const publicImage = path.join(root, "author/site/public/images/pixel.png");
  fs.mkdirSync(path.dirname(publicImage), { recursive: true });
  fs.writeFileSync(publicImage, png);
  const file = fixture("author/site/docs/note.md", `# Author HTML

<details id="more" open class="mermaid" style="display:none" data-evil="yes">
<summary>More</summary>

**Inside**

- [x] Safe task

~~~ts
const safe = 1
~~~

$x^2$

</details>

[More](#more)

![Local](/images/pixel.png)

<img alt="raw" src="/images/pixel.png" onerror="window.authorExecuted=true">
<img alt="blocked" src="file:///tmp/secret.png">
<img alt="remote" src="https://example.invalid/remote.png">
<pre class="mermaid" data-evil="yes">fake</pre>
<script>window.authorExecuted = true</script>
`);
  const pdf = path.join(root, "author-html/output.pdf");
  const html = path.join(root, "author-html/output.html");
  await launch("author-html", file, [
    evaluate(`await waitFor(() => document.querySelector('#doc details:not(.frontmatter) strong')?.textContent === 'Inside', 'Raw wrapper lost its Markdown children.');
      const doc = document.querySelector('#doc');
      await waitFor(() => doc.querySelector('details .shiki'), 'Nested Shiki code did not render.');
      assert(doc.querySelector('details .shiki') && doc.querySelector('details .katex') && doc.querySelector('details input[type="checkbox"][disabled]'), 'Author policy removed generated nodes.');
      assert(!doc.querySelector('script, style, [data-evil], [onerror], .mermaid') && !window.authorExecuted, 'Author content gained generated privileges.');
      assert(doc.querySelector('details').id === 'user-content-more' && doc.querySelector('a[href="#user-content-more"]'), 'Author IDs and fragments disagree.');
      assert(!doc.querySelector('img[alt="blocked"]').hasAttribute('src'), 'Author file URL survived.');
      await waitFor(() => [...doc.querySelectorAll('img[alt="Local"], img[alt="raw"]')].every(image => image.naturalWidth > 0), 'Astro root images did not load.');
      assert(doc.querySelector('img[alt="Local"]').src.includes('/site/public/images/'), 'Root image used the wrong ancestor.');
      assert(doc.querySelector('img[alt="remote"]').getAttribute('src') === 'https://example.invalid/remote.png', 'Remote images are not enabled by default.');
      window.simplemd.command('preferences');`),
    { settings: [evaluate(`await waitFor(() => document.querySelector('#remote-images') && !document.querySelector('#remote-images').disabled, 'Settings did not open.');
      assert((await window.simplemdSettings.get()).settings.remoteImages, 'Remote images are not on by default.');
      await window.simplemdSettings.set({ remoteImages: false });`)] },
    evaluate(`await waitFor(() => { const image = document.querySelector('#doc img[alt="remote"]'); return image && !image.hasAttribute('src'); }, 'Remote image remains enabled.');
      assert(!(await window.simplemd.ready()).settings.remoteImages, 'Remote image preference did not persist.');`),
    { pdf },
    { html },
  ]);
  assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), "%PDF-");
  const exported = fs.readFileSync(html, "utf8");
  assert(/<details\b(?=[^>]*\bid="user-content-more")(?=[^>]*\bopen="")/.test(exported) && exported.includes("<strong>Inside</strong>"), "HTML export lost the sanitized author wrapper.");
  assert(exported.includes('href="#user-content-more"') && exported.includes('type="checkbox"') && exported.includes('class="shiki') && exported.includes('class="katex"'), "HTML export lost fragments or generated markup.");
  assert(!/<script\b|\bonerror=|data-evil=|src=["'](?:file:|https?:)/i.test(exported), "HTML export retained blocked author markup or resource URLs.");
  const pdftotext = Bun.which("pdftotext");
  assert(pdftotext, "pdftotext is required to verify the sanitized PDF content.");
  const extracted = Bun.spawnSync([pdftotext, pdf, "-"]);
  assert.equal(extracted.exitCode, 0);
  assert(extracted.stdout.toString().includes("Inside") && extracted.stdout.toString().includes("Safe task"), "PDF export lost the sanitized author wrapper content.");
});

await test("edit-modes-undo-save", async () => {
  const file = fixture("edit/note.md", note);
  await launch("edit-modes-undo-save", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content'), 'CLI edit did not open CodeMirror.');
      for (const mode of ['live', 'split', 'source']) {
        document.querySelector('[data-mode="' + mode + '"][role="radio"]').click();
        await waitFor(() => document.querySelector('#edit').dataset.mode === mode, 'Mode did not switch to ' + mode);
        if (mode === 'split') await waitFor(() => document.querySelector('#preview h1')?.textContent === 'Smoke edit note', 'Split preview did not render the current note.');
      }
      assert(document.querySelector('#dirty').hidden, 'Changing modes dirtied the source.');`),
    ...appendCharacter("!"),
    evaluate(`window.simplemd.command('undo');
      await waitFor(() => !editorText().includes('!'), 'Undo did not remove the edit.');
      window.simplemd.command('redo');
      await waitFor(() => editorText().endsWith('!'), 'Redo did not restore the edit.');
      window.simplemd.command('save');
      await waitFor(() => document.querySelector('#dirty').hidden, 'Save did not acknowledge the current text.');`),
  ], "edit");
  assert.equal(fs.readFileSync(file, "utf8"), `${note}!`, "Saved bytes differ from the edited note.");
});

await test("autosave-persist", async () => {
  const file = fixture("autosave/note.md", note);
  await launch("autosave-persist", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content'), 'Editor did not open.');
      await window.simplemd.setSettings({ autosave: true });`),
    ...appendCharacter("!"),
    evaluate("await waitFor(() => document.querySelector('#dirty').hidden, 'Autosave did not acknowledge the edit.');"),
  ], "edit");
  assert.equal(fs.readFileSync(file, "utf8"), `${note}!`, "Autosave did not persist the edited bytes.");
});

await test("settings-menu-quit", async () => {
  const name = "settings-menu-quit";
  const file = fixture(`${name}/note.md`, note);
  await launch(name, file, [
    evaluate(`window.simplemd.command('preferences');`),
    { settings: [evaluate(`await window.simplemdSettings.set({ theme: 'light' });
      await waitFor(() => !matchMedia('(prefers-color-scheme: dark)').matches, 'Light setting did not change appearance.');
      await window.simplemdSettings.set({ theme: 'dark', mode: 'split', readingFontFamily: 'Charter', contentWidth: 100, autosave: true, spellcheck: false });
      await waitFor(() => matchMedia('(prefers-color-scheme: dark)').matches, 'Dark setting did not change appearance.');`),
      { shot: path.join(root, name, "settings.png") },
    ] },
    evaluate(`await waitFor(() => document.querySelector('[data-mode="split"]').getAttribute('aria-checked') === 'true', 'Editing default did not apply.');
      await waitFor(() => document.querySelector('#preview h1')?.textContent === 'Smoke edit note', 'Side by side did not render after Settings.');`),
    { menuQuit: true },
  ], "edit");
  const { parseConfig } = await import("../src/shared/config");
  const saved = parseConfig(fs.readFileSync(path.join(root, name, "profile/config"), "utf8")).settings;
  assert.equal(saved.theme, "dark");
  assert.equal(saved.mode, "split");
  assert.equal(saved.readingFontFamily, "Charter");
  assert.equal(saved.contentWidth, 100);
  assert.equal(saved.autosave, true);
  assert.equal(saved.spellcheck, false);
  const state = JSON.parse(fs.readFileSync(path.join(root, name, "profile/settings.json"), "utf8"));
  assert(!('theme' in state) && !('mode' in state), 'User settings remain in settings.json.');
  assert.equal(fs.readFileSync(file, "utf8"), note, "Settings or menu quit changed the note.");
});

await test("cache-same-stat", async () => {
  const before = "# Cache BEFORE\n";
  const after = "# Cache AFTER!\n";
  assert.equal(before.length, after.length);
  const alpha = fixture("cache/alpha.md", before);
  const timestamp = new Date("2020-01-02T03:04:05.000Z");
  fs.utimesSync(alpha, timestamp, timestamp);
  const beta = fixture("cache/beta.md", "# Cache other note\n");
  const marker = path.join(root, "cache-same-stat", "armed.png");
  await launch("cache-same-stat", alpha, [
    evaluate(`assert(document.querySelector('#doc h1')?.textContent === 'Cache BEFORE', 'Cache fixture did not open.');
      await window.simplemd.openPath(${quote(beta)}, 'read');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Cache other note', 'Second cache fixture did not open.');`),
    { shot: marker },
    evaluate(`await new Promise(resolve => setTimeout(resolve, 250));
      await window.simplemd.openPath(${quote(alpha)}, 'read');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Cache AFTER!', 'Same-size, same-mtime replacement returned cached content.');`),
  ], "read", { marker, file: alpha, text: after, preserveTimes: true });
  assert.equal(fs.readFileSync(alpha, "utf8"), after);
});

await test("mdx-editing", async () => {
  const source = '\uFEFFimport Widget from "./widget"\r\n\r\n# Smoke MDX\r\n\r\n<Card value={1}>\r\n\r\n**inside** and $x$\r\n\r\n![inside](missing.png)\r\n\r\n</Card>\r\n\r\nOutside.\n';
  const file = fixture("mdx-editing/note.mdx", source);
  await launch("mdx-editing", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content[contenteditable="true"]'), 'MDX did not enter editing.');
      const v = document.querySelector('.cm-content').cmTile.root.view;
      window.mdxView = v;
      assert(document.querySelector('.cm-mdx-esm'), 'ESM syntax is not highlighted.');
      assert(document.querySelector('.cm-mdx-tag-name'), 'JSX syntax is not highlighted.');
      for (const mode of ['live', 'source', 'split']) {
        window.simplemd.command('mode-' + mode);
        await waitFor(() => document.querySelector('#edit').dataset.mode === mode, 'MDX mode did not switch.');
        if (mode === 'live') {
          assert(document.querySelector('.cm-content').textContent.includes('**inside** and $x$'), 'Live hid markers inside JSX.');
          assert(!document.querySelector('.cm-rendered, .cm-image, .cm-math-inline'), 'Live made a widget inside JSX.');
        }
      }
      await waitFor(() => document.querySelector('#preview .mdx-component'), 'Component box did not render.');
      const at = v.state.doc.toString().indexOf('value={1}') + 8;
      v.dispatch({ changes: { from: at, insert: '0' }, userEvent: 'input.type' });
      assert(v.state.doc.toString().includes('value={10}'), 'Edit inside MDX failed.');
      window.simplemd.command('mode-live');
      await waitFor(() => document.querySelector('#edit').dataset.mode === 'live', 'Live did not return after editing.');
      await new Promise(resolve => setTimeout(resolve, 300));
      assert(document.querySelector('.cm-content').textContent.includes('**inside** and $x$'), 'Reparse hid markers inside edited JSX.');
      assert(!document.querySelector('.cm-rendered, .cm-image, .cm-math-inline'), 'Reparse made a widget inside JSX.');`),
    { save: true },
    ...appendCharacter("!"),
    { save: true },
    evaluate(`window.simplemd.command('toggle-edit');
      await waitFor(() => !document.querySelector('#read').hidden, 'MDX did not enter read view.');
      await waitFor(() => document.querySelector('#doc .mdx-label')?.textContent === 'Card', 'Read component label is missing.');
      assert(!document.querySelector('#doc').textContent.includes('import Widget'), 'ESM is visible in read view.');`),
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(source.replace('value={1}', 'value={10}') + '!'), 'MDX edits changed untouched bytes.');
});

await test("mdx-invalid-recovery", async () => {
  const source = '# Stable MDX\n\n<Widget />\n\nOutside.\n';
  const file = fixture("mdx-invalid-recovery/note.mdx", source);
  await launch("mdx-invalid-recovery", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-content'), 'MDX editor did not open.');
      window.simplemd.command('mode-split');
      await waitFor(() => document.querySelector('#preview .mdx-component'), 'Good preview is missing.');
      const v = document.querySelector('.cm-content').cmTile.root.view;
      window.mdxView = v;
      v.dispatch({ changes: { from: v.state.doc.length, insert: '\\n\\n<Broken value={' }, userEvent: 'input.paste' });
      await waitFor(() => document.querySelector('#preview .mdx-error'), 'Incomplete MDX error is missing.');
      assert(document.querySelector('#preview .mdx-component .mdx-label').textContent === 'Widget', 'Last good component disappeared.');
      assert(document.querySelector('#preview .mdx-error pre').textContent.includes('<Broken value={'), 'Failing source was not escaped.');
      assert(!document.querySelector('#preview broken'), 'Invalid source became HTML.');`),
    { save: true },
    evaluate(`const v = window.mdxView;
      v.dispatch({ changes: { from: v.state.doc.length, insert: '1} />' }, userEvent: 'input.paste' });
      await waitFor(() => !document.querySelector('#preview .mdx-error') && [...document.querySelectorAll('#preview .mdx-label')].some(el => el.textContent === 'Broken'), 'Preview did not recover.');
      window.simplemd.command('undo');
      await waitFor(() => document.querySelector('#preview .mdx-error'), 'Undo did not restore the incomplete preview.');
      window.simplemd.command('undo');
      await waitFor(() => !document.querySelector('#preview .mdx-error') && v.state.doc.toString() === ${quote(source)}, 'Undo did not restore the original source.');`),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(source), 'Recovery and undo changed the original bytes.');
});

await test("tasks-source-mapping", async () => {
  const source = "# Smoke task mapping\n\n```md\n- [ ] code example\n```\n\n> - [ ] quoted task\n\n1) [ ] ordered task\n\n- [ ] last task\n";
  const file = fixture("tasks/note.md", source);
  await launch("tasks-source-mapping", file, [
    evaluate(`assert(document.querySelectorAll('#doc .task-list-item-checkbox').length === 3, 'Task fixture did not render three real checkboxes.');
      document.querySelector('#doc .task-list-item').click();
      await waitFor(() => document.querySelector('#doc .task-list-item-checkbox')?.checked, 'Quoted task did not toggle.');
      window.simplemd.command('save');
      await waitFor(() => document.querySelector('#dirty').hidden, 'Task edit did not save.');`),
  ]);
  assert.equal(fs.readFileSync(file, "utf8"), source.replace("> - [ ] quoted", "> - [x] quoted"), "Clicking the quoted task changed the wrong source text.");
});

for (const choice of ["Reload", "Keep mine"] as const) {
  const name = choice === "Reload" ? "conflict-reload" : "conflict-keep-mine";
  await test(name, async () => {
    const file = fixture(`${name}/note.md`, note);
    const marker = path.join(root, name, "dirty.png");
    const external = "# External atomic replacement\n\nWritten outside the editor.\n";
    await launch(name, file, [
      evaluate("await waitFor(() => document.querySelector('.cm-content'), 'Editor did not open.');"),
      ...appendCharacter("!"),
      { shot: marker },
      evaluate(`await waitFor(() => !document.querySelector('#banner').hidden, 'External atomic replacement did not show a conflict.');
        const button = [...document.querySelectorAll('#banner button')].find(button => button.textContent === ${quote(choice)});
        assert(button, 'Conflict choice is missing.');
        button.click();
        await waitFor(() => document.querySelector('#banner').hidden, 'Conflict choice did not dismiss the banner.');
        ${choice === "Reload"
          ? "await waitFor(() => editorText().includes('External atomic replacement'), 'Reload did not adopt disk text.'); assert(document.querySelector('#dirty').hidden, 'Reload left the document dirty.');"
          : "assert(editorText().endsWith('!'), 'Keep mine discarded local text.'); window.simplemd.command('save'); await waitFor(() => document.querySelector('#dirty').hidden, 'Keep mine did not authorize saving local text.');"}`),
    ], "edit", { marker, file, text: external });
    assert.equal(fs.readFileSync(file, "utf8"), choice === "Reload" ? external : `${note}!`, "Conflict resolution saved the wrong content.");
  });
}

const byteFixtures = path.join(appRoot, "test/fixtures/bytes");
for (const name of ["lf", "crlf", "cr", "mixed", "bom-crlf", "no-final-newline", "astral", "binary-looking"]) {
  await test(`bytes-roundtrip-${name}`, async () => {
    const original = fs.readFileSync(path.join(byteFixtures, `${name}.md`));
    const file = fixture(`bytes-roundtrip-${name}/note.md`, original.toString());
    await launch(`bytes-roundtrip-${name}`, file, [
      evaluate(`assert(document.querySelector('.cm-content'), 'UTF-8 fixture did not enter the editor.');
        assert(!document.querySelector('.cm-content').textContent.includes('\\uFEFF'), 'BOM is visible in the editor.');
        assert(document.querySelector('#dirty').hidden, 'Opening changed the source.');`),
      { save: true },
      ...appendCharacter("!"),
      { save: true },
      evaluate(`window.simplemd.command('undo');
        await waitFor(() => !editorText().endsWith('!'), 'Undo failed.');`),
      { save: true },
    ], "edit");
    assert.deepEqual(fs.readFileSync(file), original, "Open, save, edit, save, undo, save changed the original bytes.");
  });
}

for (const name of ["invalid-utf8", "utf16le-bom", "utf16be-bom", "utf16le", "utf16be"]) {
  await test(`bytes-readonly-${name}`, async () => {
    const original = fs.readFileSync(path.join(byteFixtures, `${name}.md`));
    const file = fixture(`bytes-readonly-${name}/note.md`, "");
    fs.writeFileSync(file, original);
    await launch(`bytes-readonly-${name}`, file, [
      evaluate(`assert(!document.querySelector('#banner').hidden && document.querySelector('#banner').textContent.includes('Not a UTF-8 text file. Read only.'), 'Encoding notice is missing.');
        window.simplemd.command('toggle-edit');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(!document.querySelector('.cm-content[contenteditable="true"]'), 'Unsupported encoding is editable.');
        const id = Number(document.documentElement.dataset.documentId);
        assert(await window.simplemd.save('overwrite', false, id) === null, 'Main process allowed an overwrite.');
        assert(await window.simplemd.save('overwrite', true, id) === null, 'Main process allowed Save As from a read-only document.');`),
    ], "edit");
    assert.deepEqual(fs.readFileSync(file), original, "Read-only source bytes changed.");
  });
}

for (const [name, ending] of [["crlf", "\r\n"], ["cr", "\r"], ["mixed", "\r\n"]] as const) {
  await test(`bytes-paste-${name}`, async () => {
    const original = fs.readFileSync(path.join(byteFixtures, `${name}.md`), "utf8");
    const file = fixture(`bytes-paste-${name}/note.md`, original);
    await launch(`bytes-paste-${name}`, file, [
      ...appendCharacter("!"),
      { paste: "first\nsecond\r\nthird\rfourth" },
      evaluate(`await waitFor(() => editorText().endsWith('fourth'), 'Paste did not reach the editor.');`),
      { save: true },
      evaluate(`window.simplemd.command('undo');
        await waitFor(() => editorText().endsWith('!'), 'Undo did not remove the paste.');
        window.simplemd.command('redo');
        await waitFor(() => editorText().endsWith('fourth'), 'Redo did not restore the paste.');`),
      { save: true },
    ], "edit");
    assert.deepEqual(fs.readFileSync(file), Buffer.from(`${original}!first${ending}second${ending}third${ending}fourth`));
  });
}

await test("bytes-table", async () => {
  const original = fs.readFileSync(path.join(byteFixtures, "irregular-table.md"), "utf8");
  const file = fixture("bytes-table/note.md", original);
  const key = (keyCode: string, modifiers: string[] = []): Step[] => [
    { input: { type: "keyDown", keyCode, modifiers } },
    { input: { type: "keyUp", keyCode, modifiers } },
  ];
  await launch("bytes-table", file, [
    evaluate(`document.querySelector('.cm-content').focus();`),
    ...key("A", [mod]), ...key("Left"), ...key("Down"), ...key("Down"), ...key("Right"), ...key("Right"),
    ...key("Tab"), ...key("Tab", ["shift"]),
    evaluate(`assert(document.querySelector('#dirty').hidden, 'Table navigation changed the source.');`),
    { input: { type: "char", keyCode: "X" } },
    ...key("Tab"),
    { input: { type: "char", keyCode: "Y" } },
    ...key("Tab", ["shift"]), ...key("Tab"),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original.replace("one", "Xone").replace("two", "Ytwo")), "Table cell editing or navigation reformatted other cells or rows.");
});

await test("bytes-table-new-row", async () => {
  const original = fs.readFileSync(path.join(byteFixtures, "irregular-table.md"), "utf8");
  const file = fixture("bytes-table-new-row/note.md", original);
  const key = (keyCode: string, modifiers: string[] = []): Step[] => [
    { input: { type: "keyDown", keyCode, modifiers } },
    { input: { type: "keyUp", keyCode, modifiers } },
  ];
  await launch("bytes-table-new-row", file, [
    evaluate(`document.querySelector('.cm-content').focus();`),
    ...key("A", [mod]), ...key("Left"), ...key("Down"), ...key("Down"), ...key("Down"),
    ...key("Tab"), ...key("Tab"),
    { save: true },
    evaluate(`window.simplemd.command('undo');
      await waitFor(() => editorText().split('\\n').length === 5, 'Table row undo failed.');
      window.simplemd.command('redo');
      await waitFor(() => editorText().split('\\n').length === 6, 'Table row redo failed.');`),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original.slice(0, -2) + "\r\n| | |\r\n"), "Adding a table row rewrote existing rows.");
});

await test("bytes-external-encoding", async () => {
  const file = fixture("bytes-external-encoding/note.md", note);
  const other = fixture("bytes-external-encoding/other.md", "# Other\n");
  const marker = path.join(root, "bytes-external-encoding", "dirty.png");
  const external = "# External\u0000text\n";
  await launch("bytes-external-encoding", file, [
    ...appendCharacter("!"),
    { shot: marker },
    evaluate(`await waitFor(() => document.querySelector('#banner').textContent.includes('Not a UTF-8 text file.'), 'Invalid external revision was not reported.');
      assert(!document.querySelector('.cm-content[contenteditable="true"]'), 'External invalid revision left the editor writable.');
      const id = Number(document.documentElement.dataset.documentId);
      assert(await window.simplemd.save('overwrite', false, id) === null, 'Invalid external bytes could be overwritten.');
      [...document.querySelectorAll('#banner button')].find(button => button.textContent === 'Reload').click();
      await waitFor(() => document.querySelector('#dirty').hidden, 'Explicit read-only reload did not settle local edits.');
      await window.simplemd.openPath(${quote(other)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPath === ${quote(other)}, 'Read-only reload trapped navigation.');`),
  ], "edit", { marker, file, text: external });
  assert.deepEqual(fs.readFileSync(file), Buffer.from(external), "Recovery overwrote invalid external bytes.");
});

await test("bytes-task", async () => {
  const original = "\uFEFF# Tasks\r\n\r\n- [ ] first\r- [X] second\n- [ ] third";
  const file = fixture("bytes-task/note.md", original);
  await launch("bytes-task", file, [
    evaluate(`document.querySelectorAll('#doc .task-list-item')[1].click();
      await waitFor(() => !document.querySelector('#dirty').hidden, 'Task did not toggle.');`),
    { save: true },
    evaluate(`window.simplemd.command('undo');
      await waitFor(() => document.querySelectorAll('#doc .task-list-item-checkbox')[1]?.checked, 'Task undo failed.');
      window.simplemd.command('redo');
      await waitFor(() => !document.querySelectorAll('#doc .task-list-item-checkbox')[1]?.checked, 'Task redo failed.');`),
    { save: true },
  ]);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original.replace("[X] second", "[ ] second")), "Task toggle changed bytes outside its marker.");
});

await test("bytes-in-flight-renders", async () => {
  const original = "\uFEFF# In-flight renders\r\n\r\n" + "```typescript\r\nconst value = 42;\r\n```\r\n\r\n".repeat(800) + "Tail";
  const file = fixture("bytes-in-flight-renders/note.md", original);
  await launch("bytes-in-flight-renders", file, [
    evaluate(`await window.simplemd.setSettings({ mode: 'split' });
      await waitFor(() => document.querySelector('#preview h1'), 'Initial preview did not render.');
      const id = Number(document.documentElement.dataset.documentId);
      const revision = Number(document.documentElement.dataset.revisionId);
      window.pendingRenders = Array.from({ length: 6 }, () => window.simplemd.renderBlocks(${quote(original)}, id, revision)
        .then(() => 'rendered', error => String(error)));
      document.querySelector('.cm-content').focus();`),
    { input: { type: "keyDown", keyCode: "A", modifiers: [mod] } },
    { input: { type: "keyUp", keyCode: "A", modifiers: [mod] } },
    { input: { type: "keyDown", keyCode: "Right" } },
    { input: { type: "keyUp", keyCode: "Right" } },
    ...[..."123456789"].map((keyCode): Step => ({ input: { type: "char", keyCode } })),
    evaluate(`await waitFor(() => editorText().endsWith('Tail123456789'), 'Rapid edits did not reach the editor.');
      const outcomes = await Promise.all(window.pendingRenders);
      assert(outcomes.some(outcome => outcome.includes('Stale document revision')), 'No in-flight render was rejected after typing.');
      await waitFor(() => document.querySelector('#preview').textContent.includes('Tail123456789'), 'Latest preview did not replace the old revision.');
      const id = Number(document.documentElement.dataset.documentId);
      const revision = Number(document.documentElement.dataset.revisionId);
      assert(revision >= 9, 'Rapid edits did not advance the document revision.');
      const stale = await window.simplemd.renderBlocks(${quote(original)}, id, revision - 1).then(() => false, () => true);
      assert(stale, 'Main accepted a stale render revision.');`),
    { save: true },
    evaluate(`assert(document.querySelector('#dirty').hidden, 'Rapid edits did not settle after save.');`),
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original + "123456789"), "An in-flight render changed the saved source bytes.");
});

await test("bytes-metadata", async () => {
  if (process.platform !== "darwin") return;
  const original = fs.readFileSync(path.join(byteFixtures, "metadata.md"));
  const file = fixture("bytes-metadata/note.md", original.toString());
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(args);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    return result.stdout.toString();
  };
  const tag = '<?xml version="1.0"?><plist version="1.0"><array><string>SimpleMD\n6</string></array></plist>';
  run("xattr", "-w", "com.simplemd.test", "preserved", file);
  run("xattr", "-w", "com.apple.metadata:_kMDItemUserTags", tag, file);
  run("chmod", "640", file);
  run("chmod", "+a", "everyone allow read", file);
  const attributes = run("xattr", "-lx", file);
  const acl = run("ls", "-le", file).split("\n").slice(1).join("\n");
  await launch("bytes-metadata", file, [
    { save: true },
    ...appendCharacter("!"),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([original, Buffer.from("!")]));
  assert.equal(run("xattr", "-lx", file), attributes, "Save dropped or changed an extended attribute or Finder tag.");
  assert.equal(run("ls", "-le", file).split("\n").slice(1).join("\n"), acl, "Save changed the ACL.");
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, "Save changed permissions.");
});

await test("settings-config-themes", async () => {
  const artifactDir = path.resolve(appRoot, "../.audit/m5c");
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = fixture("settings-config-themes/note.md", '# A quieter page\n\nA document should give its words room. SimpleMD uses the same semantic renderer for an essay, a project README and a working draft.\n\n## Read with focus\n\nThe default is warm paper and clear ink. A [useful link](https://example.com) stays underlined, and **important words** carry their own weight.\n\n> Keep the file safe, and let the reader choose the page.\n\n```typescript\nconst page = { title: "A quieter page", ready: true };\n// The source stays exactly as you wrote it.\n```\n\n| Role | Choice |\n| --- | --- |\n| Reading | Editorial |\n| Writing | System UI |\n');
  const marker = path.join(root, "settings-config-themes", "external-ready.png");
  const config = path.join(root, "settings-config-themes", "profile", "config");
  await launch("settings-config-themes", file, [
    evaluate(`await waitFor(() => document.querySelector('#doc pre.shiki span'), 'Syntax did not render.');
      await window.simplemd.setSettings({ theme: 'light' });
      window.originalHeading = document.querySelector('#doc h1');
      window.originalCode = document.querySelector('#doc pre');
      window.originalChrome = getComputedStyle(document.querySelector('.titlebar')).color;
      assert(!document.querySelector('#preferences') && !document.querySelector('#preferences-btn'), 'In-document Preferences remains.');
      await waitFor(() => getComputedStyle(document.querySelector('#stage')).backgroundColor === 'rgb(251, 247, 238)', 'Editorial Light did not apply.');`),
    { shot: path.join(artifactDir, "editorial-light.png") },
    evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ${process.platform === "darwin" ? "metaKey" : "ctrlKey"}: true, bubbles: true }));`),
    { settings: [evaluate(`await waitFor(() => document.querySelector('#reading-font-family option')?.textContent, 'Settings did not list fonts.', 20000);
      assert(typeof window.simplemd === 'undefined' && typeof require === 'undefined', 'Settings has document or Node access.');
      assert(Object.keys(window.simplemdSettings).sort().join(',') === 'get,set,subscribe', 'Settings preload exposes extra APIs.');
      const snapshot = await window.simplemdSettings.get();
      assert(snapshot.fonts.length > 4 && !snapshot.fontError, 'Installed system fonts were not listed.');
      assert(document.querySelectorAll('select,input').length === 23, 'Schema controls are missing.');
      const choose = async (key, value) => {
        const input = document.getElementById(key); input.value = value; input.dispatchEvent(new Event('change', {bubbles:true}));
        await waitFor(() => !input.disabled, 'Settings did not save.');
        assert(document.querySelector('#save-error').hidden, 'Settings write failed.');
      };
      await choose('appearance', 'dark');
      await choose('theme-dark', 'solarized-dark');`),
      { shot: path.join(artifactDir, "settings.png") },
    ] },
    evaluate(`await waitFor(() => getComputedStyle(document.querySelector('#stage')).backgroundColor === 'rgb(0, 43, 54)', 'Settings theme did not reach the document.');
      assert(document.querySelector('#doc h1') === window.originalHeading && document.querySelector('#doc pre') === window.originalCode, 'Theme change reparsed the document.');
      assert(getComputedStyle(document.querySelector('.titlebar')).color !== getComputedStyle(document.querySelector('#doc')).color, 'Document theme leaked into chrome.');
      assert(getComputedStyle(document.querySelector('#doc pre span')).color !== 'rgb(0, 0, 0)', 'Syntax did not receive theme colors.');`),
    { shot: path.join(artifactDir, "solarized-dark.png") },
    { settings: [evaluate(`document.querySelector('#reading-style').click();
      await waitFor(() => !document.querySelector('#reading-style').disabled, 'GitHub style did not save.');`)] },
    evaluate(`await waitFor(() => document.documentElement.dataset.readingStyle === 'github', 'GitHub style did not reach the document.');
      const prose = getComputedStyle(document.querySelector('#doc'));
      assert(prose.fontSize === '16px' && prose.maxWidth === '980px', 'GitHub typography differs.');
      assert(getComputedStyle(document.querySelector('#doc h1')).borderBottomStyle === 'solid', 'GitHub heading has no rule.');
      assert(document.querySelector('#doc h1') === window.originalHeading, 'Reading style replaced semantic content.');`),
    { shot: marker },
    evaluate(`await waitFor(() => getComputedStyle(document.querySelector('#stage')).backgroundColor === 'rgb(255, 255, 255)' && getComputedStyle(document.querySelector('#doc')).fontSize === '21px', 'External config did not reload.');
      assert(document.documentElement.dataset.readingStyle === 'editorial', 'External reading style did not reload.');`),
    { shot: path.join(artifactDir, "github-light.png") },
    { settings: [evaluate(`await waitFor(() => document.querySelector('#config-errors').textContent.includes('future-setting'), 'Unknown config key was not reported.');
      assert(document.querySelector('#appearance').value === 'light', 'Settings did not follow external appearance.');
      assert(document.querySelector('#reading-font-size').value === '21', 'Settings did not follow external typography.');
      const snapshot = await window.simplemdSettings.get();
      assert(snapshot.issues.some(issue => issue.key === 'autosave'), 'Invalid config value was not reported.');
      await window.simplemdSettings.set({ vim: true });`)] },
  ], "read", { marker, file: config, text: '# External edit\nappearance = light\ntheme-light = github-light\nreading-style = editorial\nreading-font-size = 21\nfuture-setting = keep\nautosave = maybe\n' });
  const stored = fs.readFileSync(config, "utf8");
  assert(stored.includes('future-setting = keep') && stored.includes('autosave = maybe'), 'Settings dropped unknown or invalid lines.');
});

await test("settings-tabs-panes", async () => {
  const shots = path.resolve(appRoot, "../.audit/m5-merge");
  fs.mkdirSync(shots, { recursive: true });
  const text = '# A quieter page\n\nSimpleMD keeps the file safe while each pane keeps its own view.\n\n## Read and write\n\nA [useful link](https://example.com) and **clear words**.\n\n```typescript\nconst page = { ready: true };\n```\n';
  const a = fixture("settings-tabs-panes/reading.md", text);
  const b = fixture("settings-tabs-panes/writing.md", text.replace('A quieter page', 'Working draft'));
  const c = fixture("settings-tabs-panes/later.md", text.replace('A quieter page', 'Another page'));
  await launch("settings-tabs-panes", a, [
    evaluate(`await window.simplemd.openPath(${quote(b)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Writing tab did not mount.');
      window.writingId = Number(document.documentElement.dataset.documentId);
      window.simplemd.command('split-panes');
      await waitFor(() => document.querySelectorAll('.document-pane').length === 2, 'Two panes did not mount.');
      window.simplemd.command('mode-split');
      await waitFor(() => document.querySelector('[data-element="preview"] pre'), 'Preview did not render.');
      await window.simplemd.setSettings({ theme: 'light', themeLight: 'editorial-light' });
      await waitFor(() => [...document.querySelectorAll('.document-pane')].every(p => getComputedStyle(p).backgroundColor === 'rgb(251, 247, 238)'), 'Light theme missed a pane.');
      window.semanticHeadings = [...document.querySelectorAll('.document-pane .prose h1')];
      assert(!document.body.textContent.includes('Preferences'), 'Old Preferences text returned.');`),
    { shot: path.join(shots, "editorial-light.png") },
    evaluate(`await window.simplemd.setSettings({ theme: 'dark', themeDark: 'editorial-dark' });
      await waitFor(() => [...document.querySelectorAll('.document-pane')].every(p => getComputedStyle(p).backgroundColor === 'rgb(10, 18, 25)'), 'Dark theme missed a pane.');
      assert(window.semanticHeadings.every(h => h.isConnected), 'Theme replaced document nodes.');`),
    { shot: path.join(shots, "editorial-dark.png") },
    evaluate(`await window.simplemd.setSettings({ readingStyle: 'github', writingFontFamily: 'Georgia', writingFontSize: 20, codeFontFamily: 'Menlo', codeFontSize: 15 });
      await waitFor(() => [...document.querySelectorAll('.document-pane .prose')].every(p => getComputedStyle(p).fontSize === '16px'), 'GitHub style missed a pane.');
      assert(window.semanticHeadings.every(h => h.isConnected), 'Reading style replaced document nodes.');
      const editor = document.querySelector('.cm-content');
      assert(getComputedStyle(editor).fontSize === '20px' && getComputedStyle(editor).fontFamily.includes('Georgia'), 'Writing typography did not apply.');
      assert([...document.querySelectorAll('.prose pre code')].every(c => getComputedStyle(c).fontSize === '15px' && getComputedStyle(c).fontFamily.includes('Menlo')), 'Code typography missed a pane.');
      const reading = [...document.querySelectorAll('.document-pane')].find(p => p.querySelector('[data-element="read"]').hidden === false);
      assert(reading, 'Reading pane disappeared.');
      await window.simplemd.focusPane(Number(reading.dataset.paneId));
      reading.querySelector('[data-element="edit-btn"]').click();
      await waitFor(() => document.querySelectorAll('.cm-editor').length === 2, 'Reading pane did not enter edit mode.');
      window.simplemd.command('mode-live');
      await window.simplemd.setSettings({ readingStyle: 'editorial', readingFontFamily: 'Georgia', readingFontSize: 22 });
      await waitFor(() => [...document.querySelectorAll('.prose')].every(p => getComputedStyle(p).fontSize === '22px'), 'Reading typography missed a pane.');
      const modes = [...document.querySelectorAll('[data-element="edit"]')].map(p => p.dataset.mode);
      assert(modes.includes('live') && modes.includes('split'), 'Reading style changed independent modes.');
      await window.simplemd.openPath(${quote(c)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(c)}, 'Third tab did not mount.');
      window.simplemd.command('split-panes');
      await waitFor(() => document.querySelectorAll('.document-pane').length === 1, 'Panes did not collapse.');
      await window.simplemd.setSettings({ writingFontSize: 23, themeDark: 'solarized-dark' });
      await window.simplemd.activateTab(window.writingId);
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Dormant tab did not remount.');
      assert(getComputedStyle(document.querySelector('.document-pane')).backgroundColor === 'rgb(0, 43, 54)', 'Remounted tab missed the theme.');
      assert(getComputedStyle(document.querySelector('.cm-content')).fontSize === '23px', 'Remounted tab missed typography.');
      assert(document.querySelectorAll('.cm-editor').length === 1, 'Inactive editor remained mounted.');`),
  ]);
  for (const file of [a, b, c]) assert.equal(fs.readFileSync(file, "utf8"), file === b ? text.replace('A quieter page', 'Working draft') : file === c ? text.replace('A quieter page', 'Another page') : text);
});

await test("tabs-clean-payload", async () => {
  const a = fixture("tabs-payload/a.md", note), b = fixture("tabs-payload/b.md", "# Clean payload\n");
  await launch("tabs-clean-payload", a, [evaluate(`window.simplemd.onDoc(payload => { window.lastPayload = payload; });
    await window.simplemd.openPath(${quote(b)}, 'edit');
    assert(window.lastPayload.text === ${quote("# Clean payload\n")}, 'Wrong payload text');
    assert(window.lastPayload.savedText === undefined, 'Clean document sent its source twice');`)], "edit");
});

await test("tabs-panes", async () => {
  const aText = "\uFEFF# Tab A\r\n\r\n[Sibling](b.md)\r\nTail";
  const bText = "# Tab B\n\nSecond document.\n";
  const a = fixture("tabs-panes/a.md", aText), b = fixture("tabs-panes/b.md", bText);
  const shots = path.resolve(appRoot, "../.audit/m5a");
  fs.mkdirSync(shots, { recursive: true });
  await launch("tabs-panes", a, [
    ...appendCharacter("!"),
    evaluate(`window.tabA = Number(document.documentElement.dataset.documentId);
      await window.simplemd.openPath(${quote(b)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Second tab did not mount.');
      window.tabB = Number(document.documentElement.dataset.documentId);
      assert(document.querySelectorAll('[role="tab"]').length === 2, 'Missing tabs.');
      assert(document.querySelectorAll('.cm-editor').length === 1, 'Inactive editor stayed mounted.');
      await window.simplemd.openPath(${quote(a)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Existing tab did not focus.');
      assert(document.querySelectorAll('[role="tab"]').length === 2, 'Existing open duplicated a tab.');
      assert(document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().endsWith('Tail!'), 'Unsaved text lost.');
      window.simplemd.command('undo');
      await waitFor(() => !document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().endsWith('!'), 'Undo lost across remount.');
      window.simplemd.command('redo');
      await waitFor(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().endsWith('!'), 'Redo lost across remount.');`),
    { shot: path.join(shots, "one-pane.png") },
    { save: true },
    evaluate(`window.simplemd.command('split-panes');
      await waitFor(() => document.querySelectorAll('.cm-editor').length === 2, 'Two panes did not mount.');
      const all = [...document.querySelectorAll('.document-pane')];
      assert(all.every(p => p.getBoundingClientRect().width > 200), 'Pane has no visible width.');
      window.simplemd.command('mode-live');
      await window.simplemd.focusPane(Number(all[1].dataset.paneId));
      window.simplemd.command('mode-split');
      await waitFor(() => all[1].querySelector('[data-element="edit"]').dataset.mode === 'split', 'Second mode did not change.').catch(error => { throw new Error(error.message + JSON.stringify(all.map(p => ({ active: p.dataset.active, pane: p.dataset.paneId, id: p.dataset.documentId, mode: p.querySelector('[data-element=edit]').dataset.mode })))); });
      assert(all[0].querySelector('[data-element="edit"]').dataset.mode === 'live', 'Mode leaked between panes.');
      all[0].querySelector('[data-element="editor-host"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await waitFor(() => all[0].dataset.active === 'true', 'Click did not focus first pane.');`),
    { windowCount: 1 },
    { shot: path.join(shots, "two-panes.png") },
    evaluate(`window.simplemd.command('stack-panes');
      await waitFor(() => document.querySelector('#stage').dataset.axis === 'vertical', 'Stack layout did not apply.');
      const all = [...document.querySelectorAll('.document-pane')];
      assert(all[1].getBoundingClientRect().top > all[0].getBoundingClientRect().top, 'Panes did not stack.');`),
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(aText + "!"), "Tab remount or undo changed untouched bytes.");
  assert.deepEqual(fs.readFileSync(b), Buffer.from(bText), "Other pane changed saved bytes.");
});

for (const response of [0, 1] as const) await test(`tabs-dirty-close-${response === 0 ? "save" : "discard"}`, async () => {
  const a = fixture(`tabs-close-${response}/a.md`, note), b = fixture(`tabs-close-${response}/b.md`, "# Other\n");
  await launch(`tabs-close-${response}`, a, [
    ...appendCharacter("!"),
    evaluate(`window.closeId = Number(document.documentElement.dataset.documentId); await window.simplemd.openPath(${quote(b)}, 'edit');`),
    { dialog: { response } },
    evaluate(`assert(await window.simplemd.closeTab(window.closeId), 'Dirty close failed.');
      await waitFor(() => document.querySelectorAll('[role="tab"]').length === 1, 'Closed tab remains.');
      assert(document.querySelector('#tabs').hidden, 'Single tab strip stayed visible.');`),
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(note + (response === 0 ? "!" : "")));
});

await test("tabs-autosave-dormant", async () => {
  const a = fixture("tabs-autosave/a.md", note), b = fixture("tabs-autosave/b.md", "# Other\n");
  await launch("tabs-autosave-dormant", a, [
    evaluate(`await window.simplemd.setSettings({ autosave: true }); window.autosaveId = Number(document.documentElement.dataset.documentId);`),
    ...appendCharacter("!"),
    evaluate(`await window.simplemd.openPath(${quote(b)}, 'edit');`),
    { wait: 1100 },
    evaluate(`await window.simplemd.activateTab(window.autosaveId); await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Autosaved tab did not mount');
      assert(document.querySelector('#dirty').hidden, 'Dormant tab did not autosave');`),
  ], "edit");
  assert.equal(fs.readFileSync(a, "utf8"), note + "!");
});
await test("tabs-autosave-close", async () => {
  const a = fixture("tabs-autosave-close/a.md", note);
  await launch("tabs-autosave-close", a, [
    { noSavePrompt: true }, evaluate(`await window.simplemd.setSettings({ autosave: true });`),
    ...appendCharacter("!"),
    evaluate(`assert(await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId)), 'Autosave close refused');`),
    { visibility: false },
  ], "edit");
  assert.equal(fs.readFileSync(a, "utf8"), note + "!");
});

await test("tabs-render-in-flight", async () => {
  const source = "\uFEFF# Render A\r\n\r\n" + "```ts\r\nconst n = 1;\r\n```\r\n".repeat(200);
  const a = fixture("tabs-render/a.md", source), b = fixture("tabs-render/b.md", "# Render B\n");
  await launch("tabs-render", a, [
    ...appendCharacter("!"),
    evaluate(`window.renderA = Number(document.documentElement.dataset.documentId);
      const revision = Number(document.documentElement.dataset.revisionId);
      window.lateRender = window.simplemd.renderBlocks(${quote(source + "!")}, window.renderA, revision).then(result => result, error => String(error));
      await window.simplemd.openPath(${quote(b)}, 'edit');
      await window.lateRender;
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'B did not mount.');
      assert(document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === '# Render B\\n', 'Late A render replaced B.');
      await window.simplemd.activateTab(window.renderA);
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'A did not remount.');`),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(source + "!"));
  assert.deepEqual(fs.readFileSync(b), Buffer.from("# Render B\n"));
});

await test("tabs-inactive-pane-link", async () => {
  const a = fixture("tabs-inactive-link/a.md", "# A\n\n[Sibling](c.md)\n");
  const b = fixture("tabs-inactive-link/b.md", "# B\n");
  const c = fixture("tabs-inactive-link/c.md", "# C\n");
  await launch("tabs-inactive-pane-link", a, [evaluate(`
    window.linkA = Number(document.documentElement.dataset.documentId);
    await window.simplemd.openPath(${quote(b)}, 'read');
    window.linkB = Number(document.documentElement.dataset.documentId);
    window.simplemd.command('split-panes');
    await waitFor(() => document.querySelectorAll('.document-pane').length === 2, 'Split did not mount');
    await window.simplemd.activateTab(window.linkB);
    const clicked = [...document.querySelectorAll('.document-pane')].find(p => Number(p.dataset.documentId) === window.linkA);
    clicked.querySelector('a').click();
    await waitFor(() => [...document.querySelectorAll('.document-pane')].some(p => p.dataset.documentPath === ${quote(c)}), 'Clicked pane did not navigate');
    assert([...document.querySelectorAll('.document-pane')].some(p => p.dataset.documentPath === ${quote(b)}), 'Link replaced the active pane');
    assert(![...document.querySelectorAll('.document-pane')].some(p => p.dataset.documentPath === ${quote(a)}), 'Clicked pane was not replaced');
  `)], "read");
});

await test("tabs-keyboard-focus", async () => {
  const a = fixture("tabs-focus/a.md", note), b = fixture("tabs-focus/b.md", "# B\n"), c = fixture("tabs-focus/c.md", "# C\n");
  await launch("tabs-keyboard-focus", a, [
    evaluate(`await window.simplemd.openPath(${quote(b)}, 'edit'); await window.simplemd.openPath(${quote(c)}, 'edit');
      window.originalTabNodes = [...document.querySelectorAll('[role=tab]')];
      document.querySelector('[role=tab][aria-selected=true]').focus();`),
    { input: { type: "keyDown", keyCode: "Left" } }, { input: { type: "keyUp", keyCode: "Left" } },
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Arrow did not switch tab');
      await new Promise(r => setTimeout(r, 100));
      assert(document.activeElement.matches('[role=tab][aria-selected=true]'), 'Arrow moved focus out of the tablist');
      assert(window.originalTabNodes.every(tab => tab.isConnected), 'Tab update replaced nodes');`),
    { input: { type: "keyDown", keyCode: "Home" } }, { input: { type: "keyUp", keyCode: "Home" } },
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Home did not select first tab'); assert(document.activeElement.matches('[role=tab]'), 'Home lost focus');`),
    { input: { type: "keyDown", keyCode: "End" } }, { input: { type: "keyUp", keyCode: "End" } },
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(c)}, 'End did not select last tab'); assert(document.activeElement.matches('[role=tab]'), 'End lost focus');`),
    evaluate(`assert([...document.querySelectorAll('[role=tab] button')].every(button => button.tabIndex === -1), 'Nested close buttons are focusable');`),
    { debug: { method: "Emulation.setEmulatedMedia", params: { features: [{ name: "forced-colors", value: "active" }] } } },
    evaluate(`const style = getComputedStyle(document.querySelector('[role=tab][aria-selected=true]')); assert(style.outlineWidth === '2px' && style.outlineStyle === 'solid', 'Selected tab has no forced-colors outline');`),
    { input: { type: "keyDown", keyCode: "Delete" } }, { input: { type: "keyUp", keyCode: "Delete" } },
    evaluate(`await waitFor(() => document.querySelectorAll('[role=tab]').length === 2, 'Delete did not close the focused tab');`),
  ], "edit");
});

await test("tabs-sibling-command-click", async () => {
  const a = fixture("tabs-links/a.md", "# Link A\n\n[Sibling](b.md)\n"), b = fixture("tabs-links/b.md", "# Link B\n");
  await launch("tabs-links", a, [
    evaluate(`document.querySelector('#doc a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ${process.platform === "darwin" ? "metaKey" : "ctrlKey"}: true }));
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Modified click did not open sibling.');
      assert(document.querySelectorAll('[role="tab"]').length === 2, 'Modified click replaced current tab.');
      await window.simplemd.closeTab(Number(document.documentElement.dataset.documentId));
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Link origin did not return.');
      document.querySelector('#doc a').click();
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Plain click did not navigate.');
      assert(document.querySelectorAll('[role="tab"]').length === 1, 'Plain click created another tab.');
      window.simplemd.command('nav-back');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Back did not navigate.');
      window.simplemd.command('nav-forward');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Forward did not navigate.');`),
  ]);
});

await test("tabs-windows", async () => {
  const a = fixture("tabs-windows/a.md", note), b = fixture("tabs-windows/b.md", "# Separate window\n");
  const c = fixture("tabs-windows/c.md", "# New tab in remaining window\n");
  await launch("tabs-windows", a, [
    ...appendCharacter("!"),
    evaluate(`window.simplemd.command('move-tab-window');`),
    { wait: 300 },
    { windowCount: 1 },
    { selectWindow: 0 },
    { save: true },
    evaluate(`await window.simplemd.openPath(${quote(a)}, 'edit');`),
    { windowCount: 1 },
    evaluate(`await window.simplemd.setSettings({ openIn: 'window' }); await window.simplemd.openPath(${quote(b)}, 'edit');`),
    { windowCount: 2 },
    { selectWindow: b },
    evaluate(`await window.simplemd.setSettings({ openIn: 'tab' }); window.simplemd.command('close-tab');`),
    { wait: 200 },
    { windowCount: 1 },
    { selectWindow: a },
    evaluate(`await window.simplemd.openPath(${quote(c)}, 'edit');`),
    { windowCount: 1 },
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(note + "!"), "Moving a dirty tab lost unsaved bytes.");
});

await test("tabs-scroll-selection-shortcuts", async () => {
  const source = ("# Scroll\n\nA paragraph with enough text to fill the editor.\n\n").repeat(1800).slice(0, 100000);
  const a = fixture("tabs-scroll/a.md", source), b = fixture("tabs-scroll/b.md", "# Next\n");
  const key = (keyCode: string, modifiers: string[] = []): Step[] => [
    { input: { type: "keyDown", keyCode, modifiers } }, { input: { type: "keyUp", keyCode, modifiers } },
  ];
  await launch("tabs-scroll", a, [
    evaluate(`window.scrollId = Number(document.documentElement.dataset.documentId);
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: 50000 }, scrollIntoView: true });
      await waitFor(() => view.scrollDOM.scrollTop > 1000, 'Scroll did not move.');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.savedScroll = view.scrollSnapshot().value;
      await window.simplemd.openPath(${quote(b)}, 'edit');
      await window.simplemd.activateTab(window.scrollId);
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Scrolled tab did not return.');
      const restored = document.querySelector('.cm-content').cmTile.root.view;
      assert(restored.state.selection.main.head === 50000, 'Selection lost across switch.');
      await waitFor(() => { const scroll = restored.scrollSnapshot().value; return scroll.range.head === window.savedScroll.range.head && Math.abs(scroll.yMargin - window.savedScroll.yMargin) < 3; }, 'Visible source position lost across switch.');
      const otherId = [...document.querySelectorAll('[role=tab]')].map(tab => Number(tab.dataset.documentId)).find(id => id !== window.scrollId);
      await Promise.all([window.simplemd.activateTab(otherId), window.simplemd.activateTab(window.scrollId), window.simplemd.activateTab(otherId), window.simplemd.activateTab(window.scrollId)]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)} && document.querySelectorAll('.cm-editor').length === 1, 'Rapid activations did not converge.');`),
    ...key("Tab", ["control"]),
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(b)}, 'Control-Tab did not cycle.');`),
    ...key("1", [mod]),
    evaluate(`await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(a)}, 'Tab number did not jump.');`),
    ...key("T", [mod]),
    evaluate(`await waitFor(() => document.querySelectorAll('[role="tab"]').length === 3, 'New tab shortcut failed.');`),
    ...key("W", [mod]),
    evaluate(`await waitFor(() => document.querySelectorAll('[role="tab"]').length === 2, 'Close tab shortcut failed.');`),
    { windowCount: 1 },
  ], "edit");
  assert.deepEqual(fs.readFileSync(a), Buffer.from(source));
});

await test("tabs-resident-closed-read-checker", async () => {
  const text = "# Resident reopen\n\nReadable text.\n";
  const file = fixture("tabs-resident-checker/note.md", text);
  await launch("tabs-resident-closed-read-checker", file, [
    evaluate(`window.simplemd.command('close-tab');`), { wait: 200 }, { visibility: false },
    evaluate(`await window.simplemd.openPath(${quote(file)}, 'read');`),
    assertPerfDocument(file, text),
  ], "read");
});

for (const native of [false, true]) await test(`tabs-last-close-${native ? "native" : "command"}`, async () => {
  const name = `tabs-last-close-${native ? "native" : "command"}`;
  const file = fixture(`${name}/note.md`, note);
  await launch(name, file, [
    evaluate(`window.residentToken = 'same renderer';`),
    native ? { closeWindow: true } : evaluate(`window.simplemd.command('close-tab');`),
    { wait: 200 }, { windowCount: 1 }, { visibility: false },
    evaluate(`assert(document.querySelectorAll('.cm-editor').length === 0 && document.querySelectorAll('[role="tab"]').length === 0, 'Closed layout was retained'); assert(document.documentElement.dataset.documentPath === undefined, 'Closed window retained document identity');
      await window.simplemd.openPath(${quote(file)}, 'edit');
      await waitFor(() => document.documentElement.dataset.documentPainted === ${quote(file)}, 'Resident window did not reopen');
      assert(window.residentToken === 'same renderer', 'Reopen replaced resident renderer');`),
    { visibility: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(note));
});


const contextBase = { selectionPresent: false, editable: false, linkURL: "", imageURL: "", misspelledWord: "", suggestions: [] };
await test("native-menu-rebuilds", async () => {
  const a = fixture("native-menu-rebuilds/a.md", note), b = fixture("native-menu-rebuilds/b.md", "# Recent\n");
  await launch("native-menu-rebuilds", a, [
    { nativeMenus: "capture" },
    evaluate(`await window.simplemd.setSettings({ bounds: { x: 100, y: 100, width: 850, height: 700 }, zoom: 1.1 });`),
    { nativeMenus: "unchanged" },
    evaluate(`window.simplemd.command('mode-live'); await waitFor(() => document.querySelector('[data-element=modes] button[data-mode=live]')?.getAttribute('aria-checked') === 'true', 'Mode did not update');`),
    { wait: 100 }, { nativeMenus: "app-only" },
    evaluate(`await window.simplemd.openPath(${quote(b)}, 'edit');`),
    { nativeMenus: "recents" },
  ], "edit");
});

await test("native-context-link-image", async () => {
  const sibling = fixture("native-context/sibling.md", "# Sibling\n");
  const image = fixture("native-context/image.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
  const file = fixture("native-context/note.md", "[Sibling](sibling.md)\n\n![Image](image.svg)\n\n[Bottom](#bottom)\n\n" + "Paragraph.\n\n".repeat(80) + "# Bottom\n");
  await launch("native-context-link-image", file, [
    evaluate(`await waitFor(() => document.querySelector('.prose a') && document.querySelector('.prose img'), 'Context fixtures did not render');`),
    { nativeContext: { selector: ".prose img", context: { ...contextBase, imageURL: new URL("file://" + image).href }, labels: ["Copy Image Address", process.platform === "darwin" ? "Reveal in Finder" : process.platform === "win32" ? "Reveal in Explorer" : "Show in File Manager"] } },
    { nativeContext: { selector: '.prose a[href="#user-content-bottom"]', context: { ...contextBase, linkURL: "#user-content-bottom" }, labels: ["Open Link", "Copy Link"], choose: "Open Link" } },
    evaluate(`await waitFor(() => document.querySelector('.document-pane [data-element=read] .scroller')?.scrollTop > 0, 'Context fragment did not scroll');`),
    { nativeContext: { selector: ".prose a", context: { ...contextBase, linkURL: new URL("file://" + sibling).href }, labels: ["Open Link", "Copy Link", "Open in New Tab"], choose: "Open in New Tab" } },
    evaluate(`await waitFor(() => document.querySelectorAll('[role=tab]').length === 2 && document.documentElement.dataset.documentPath === ${quote(sibling)}, 'Context action did not open sibling tab');`),
  ]);
});
await test("native-context-spelling", async () => {
  const text = "\ufeffwrod 😀\r\nnext  \rlast\n";
  const file = fixture("native-spelling/note.md", text);
  await launch("native-context-spelling", file, [
    evaluate(`await waitFor(() => document.querySelector('.cm-line'), 'Missing editor');`),
    { nativeContext: { selector: ".cm-line", context: { ...contextBase, editable: true, misspelledWord: "wrod", suggestions: ["word"] }, labels: ["word", "Add to Dictionary", "Cut", "Copy", "Paste", "Paste as Plain Text", "Select All"], choose: "word" } },
    evaluate(`await waitFor(() => editorText().startsWith('word'), 'Spelling action did not replace through CodeMirror');`),
    { save: true },
    evaluate(`window.simplemd.command('undo'); await waitFor(() => editorText().startsWith('wrod'), 'Spelling undo did not restore source');`),
    { save: true },
  ], "edit");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(text));
});
await test("native-recents-identity-accent", async () => {
  const file = fixture("native-recents/note.md", "# Native\n");
  await launch("native-recents-identity-accent", file, [
    evaluate(`const ready = await window.simplemd.ready(); assert(ready.settings.recents.includes(${quote(file)}), 'Opened file missing from recents');`),
    { nativeIdentity: { file, edited: false } },
    ...appendCharacter("x"),
    { nativeIdentity: { file, edited: true } },
    evaluate(`window.simplemd.command('undo'); await waitFor(() => document.querySelector('#dirty').hidden, 'Undo retained edited state');`),
    { nativeIdentity: { file, edited: false } },
    evaluate(`document.documentElement.style.setProperty('--tab-accent', '#000000');`),
    { nativeAccent: true },
    evaluate(`if (document.body.dataset.platform !== 'linux') await waitFor(() => document.documentElement.style.getPropertyValue('--tab-accent') === document.documentElement.style.getPropertyValue('--system-accent'), 'Accent event did not update tabs');`),
    { nativeMenu: ["File", "Open Recent", "Clear Menu"] },
    evaluate(`assert((await window.simplemd.ready()).settings.recents.length === 0, 'Clear Menu retained recents'); window.simplemd.command('new'); await waitFor(() => document.documentElement.dataset.documentPath === '', 'Untitled tab did not open');`),
    { nativeIdentity: { file: "", edited: false } },
  ], "edit");
});
if (process.platform === "darwin") await test("native-find-pasteboard", async () => {
  const file = fixture("native-find/note.md", "find this word\n");
  await launch("native-find-pasteboard", file, [
    { nativeFind: null },
    evaluate(`const line = document.querySelector('.prose p'); const range = document.createRange(); range.selectNodeContents(line); window.getSelection().removeAllRanges(); window.getSelection().addRange(range);`),
    { nativeMenu: ["Edit", "Use Selection for Find"] },
    { wait: 100 },
    { nativeFind: "find this word" },
    { nativeMenu: ["Edit", "Find…"] },
    evaluate(`await waitFor(() => document.querySelector('#find-input').value === 'find this word', 'Read find did not read system pasteboard'); document.querySelector('#find-input').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); window.simplemd.command('toggle-edit'); await waitFor(() => document.querySelector('.cm-content'), 'Editor did not open');`),
    { nativeMenu: ["Edit", "Find…"] },
    evaluate(`await waitFor(() => document.querySelector('.cm-search input[name=search]')?.value === 'find this word', 'Editor find did not read system pasteboard');`),
  ]);
});

const blog = process.env.SMD_BYTE_BLOG_DIR;
if (blog) for (const name of fs.readdirSync(blog).filter((name) => name.endsWith(".mdx")).sort()) {
  await test(`bytes-blog-${name}`, async () => {
    const source = path.join(blog, name);
    const original = fs.readFileSync(source);
    const file = fixture(`bytes-blog-${name}/${name}`, "");
    fs.copyFileSync(source, file);
    await launch(`bytes-blog-${name}`, file, [{ save: true }], "edit");
    assert.deepEqual(fs.readFileSync(file), original, "Blog copy did not round-trip byte-for-byte.");
    assert.deepEqual(fs.readFileSync(source), original, "Original blog file changed during the check.");
  });
}

assert(results.length, `No smoke cases match ${quote(filter)}.`);
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
console.log(`Artifacts: ${root}`);
console.log(`${results.filter(result => result.status === "passed").length}/${results.length} smoke cases passed.`);
process.exitCode = results.some(result => result.status === "failed") ? 1 : 0;

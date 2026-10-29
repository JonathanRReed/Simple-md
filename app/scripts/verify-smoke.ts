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
    const waitFor = async (predicate, message) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
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

async function launch(name: string, file: string, steps: Step[], intent: "peek" | "edit" = "peek", change?: DiskChange, expectedExit: 0 | 1 = 0): Promise<void> {
  const output = path.join(root, name);
  const profile = path.join(output, "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
    mode: "source", autosave: false, spacePreview: false, launchAtLogin: false, peekPrompted: true,
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
    const timeout = setTimeout(() => child.kill("SIGTERM"), 35_000);
    const forceTimeout = setTimeout(() => child.kill("SIGKILL"), 38_000);
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

await test("driver-assertion-failure", async () => {
  const file = fixture("driver-check/note.md", note);
  await launch("driver-assertion-failure", file, [
    { assert: "false /* SMOKE_EXPECTED_DRIVER_FAILURE */" },
  ], "peek", undefined, 1);
  assert.equal(fs.readFileSync(file, "utf8"), note, "Failed driver changed its source note.");
});

await test("render-links-pdf", async () => {
  const source = "# Smoke render alpha\n\n## [Introduction](https://example.com)\n\n[Jump](#introduction)\n\n![image](image%20%231.png)\n\n[Next](../beta/note%20%231.md)\n\n```ts\nconst smoke = 42;\n```\n\nInline $E=mc^2$.\n\n```mermaid\ngraph LR\nStart-->Finish\n```\n\n<script>window.smokeInjected = true</script>\n\n[unsafe](javascript:alert(1))\n";
  const alpha = fixture("alpha/note.md", source);
  fixture("beta/note #1.md", "# Smoke render beta\n\n![image](image%20%231.png)\n");
  fs.writeFileSync(path.join(root, "alpha/image #1.png"), png);
  fs.writeFileSync(path.join(root, "beta/image #1.png"), png);
  const pdf = path.join(root, "render-links-pdf/output.pdf");
  const html = path.join(root, "render-links-pdf/output.html");
  await launch("render-links-pdf", alpha, [
    evaluate(`await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render alpha', 'Initial note did not render.');
      assert(document.documentElement.dataset.firstReadable === ${quote(alpha)}, 'First-readable marker is missing.');
      assert(document.querySelector('#edit').hidden, 'Peek opened an editor.');
      assert(document.querySelector('#doc .shiki'), 'Shiki code did not render.');
      assert(document.querySelector('#doc .katex'), 'KaTeX did not render.');
      assert(document.querySelector('#doc #user-content-introduction'), 'Linked heading has no matching fragment target.');
      await waitFor(() => document.querySelector('#doc .diagram svg'), 'Pele diagram did not render.');
      await waitFor(() => document.querySelector('#doc img')?.naturalWidth > 0, 'Relative image with a hash in its filename did not load.');
      assert(!document.querySelector('#doc script, #doc [onerror]'), 'Raw HTML became active DOM.');
      assert(!window.smokeInjected, 'Raw Markdown script executed.');
      assert(!document.querySelector('#doc a[href^="javascript:"]'), 'Unsafe link became clickable.');
      assert(typeof window.require === 'undefined', 'Renderer has Node require.');
      document.querySelector('#doc a[href*="note%20%231.md"]').click();
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke render beta' && !document.querySelector('#edit').inert, 'Encoded Markdown link did not commit.');
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

await test("preferences-menu-quit", async () => {
  const name = "preferences-menu-quit";
  const file = fixture(`${name}/note.md`, note);
  await launch(name, file, [
    evaluate(`window.simplemd.command('preferences');
      await waitFor(() => document.querySelector('#preferences').open, 'Preferences did not open.');
      const change = async (selector, value) => {
        const input = document.querySelector(selector);
        if (input.type === 'checkbox') input.checked = value; else input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => !input.disabled && document.querySelector('#pref-status').textContent === 'Changes save automatically.', 'Preference did not save: ' + selector);
      };
      await change('#pref-theme', 'light');
      await waitFor(() => !matchMedia('(prefers-color-scheme: dark)').matches, 'Light preference did not change appearance.');
      await change('#pref-theme', 'dark');
      await waitFor(() => matchMedia('(prefers-color-scheme: dark)').matches, 'Dark preference did not change appearance.');
      await change('#pref-mode', 'split');
      await change('#pref-typeface', 'serif');
      await change('#pref-width', 'wide');
      await change('#pref-zoom', '110');
      await change('#pref-autosave', true);
      await change('#pref-spellcheck', false);
      const original = (await window.simplemd.ready()).settings.shortcut;
      document.querySelector('#pref-shortcut').value = 'not a shortcut';
      document.querySelector('#pref-shortcut-apply').click();
      await waitFor(() => document.querySelector('#pref-status').dataset.error === 'true', 'Invalid shortcut was accepted.');
      assert((await window.simplemd.ready()).settings.shortcut === original, 'Invalid shortcut replaced the confirmed shortcut.');`),
    { shot: path.join(root, name, "preferences.png") },
    { input: { type: "keyDown", keyCode: "Escape" } },
    { input: { type: "keyUp", keyCode: "Escape" } },
    evaluate(`await waitFor(() => !document.querySelector('#preferences').open, 'Escape did not close Preferences.');
      assert(document.querySelector('[data-mode="split"]').getAttribute('aria-checked') === 'true', 'Editing default did not apply.');
      await waitFor(() => document.querySelector('#preview h1')?.textContent === 'Smoke edit note', 'Split preview did not render after Preferences.');`),
    { menuQuit: true },
  ], "edit");
  const saved = JSON.parse(fs.readFileSync(path.join(root, name, "profile/settings.json"), "utf8"));
  assert.equal(saved.theme, "dark");
  assert.equal(saved.mode, "split");
  assert.equal(saved.typeface, "serif");
  assert.equal(saved.width, "wide");
  assert.equal(saved.zoom, 1.1);
  assert.equal(saved.autosave, true);
  assert.equal(saved.spellcheck, false);
  assert.equal(fs.readFileSync(file, "utf8"), note, "Preferences or menu quit changed the note.");
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
      await window.simplemd.openPath(${quote(beta)}, 'peek');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Cache other note', 'Second cache fixture did not open.');`),
    { shot: marker },
    evaluate(`await new Promise(resolve => setTimeout(resolve, 250));
      await window.simplemd.openPath(${quote(alpha)}, 'peek');
      await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Cache AFTER!', 'Same-size, same-mtime replacement returned cached content.');`),
  ], "peek", { marker, file: alpha, text: after, preserveTimes: true });
  assert.equal(fs.readFileSync(alpha, "utf8"), after);
});

await test("mdx-readonly", async () => {
  const source = "import Widget from './widget'\n\n# Smoke MDX\n\n<Widget />\n\n- [ ] protected task\n";
  const file = fixture("mdx/note.mdx", source);
  await launch("mdx-readonly", file, [
    evaluate(`await waitFor(() => document.querySelector('#doc h1')?.textContent === 'Smoke MDX', 'MDX did not render.');
      assert(document.querySelector('#edit').hidden, 'MDX CLI open entered edit mode.');
      assert(!document.querySelector('#doc').textContent.includes('import Widget'), 'MDX import was not removed.');
      assert(document.querySelector('#doc code')?.textContent.includes('<Widget />'), 'MDX JSX did not render as code.');
      window.simplemd.command('toggle-edit');
      await new Promise(resolve => setTimeout(resolve, 150));
      assert(document.querySelector('#edit').hidden, 'Read/edit command made MDX editable.');
      document.querySelector('#doc .task-list-item')?.click();
      await new Promise(resolve => setTimeout(resolve, 150));
      assert(document.querySelector('#dirty').hidden, 'Read-only MDX task became dirty.');
      assert(!document.querySelector('.cm-content[contenteditable="true"]'), 'MDX has an editable CodeMirror document.');`),
  ], "edit");
  assert.equal(fs.readFileSync(file, "utf8"), source, "Read-only MDX source changed.");
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

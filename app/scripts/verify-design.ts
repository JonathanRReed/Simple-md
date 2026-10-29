import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DriverStep } from "../src/main/driver";

const phase = process.argv[2] ?? "after";
assert(["before", "after"].includes(phase));
const workspace = path.resolve(import.meta.dir, "../..");
const appRoot = process.env.SMD_DESIGN_APP_ROOT ?? path.join(workspace, "app");
const output = path.join(workspace, ".audit/design", phase);
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "simplemd-design-"));
const profile = path.join(temporary, "profile");
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, launchAtLogin: false }));
const text = '# A quieter page\n\nSimpleMD keeps the file safe while each pane keeps its own view.\n\n## Read and write\n\nA [useful link](https://example.com) and **clear words**.\n\n```typescript\nconst page = { ready: true };\n```\n';
const reading = path.join(temporary, "reading.md");
const writing = path.join(temporary, "working-draft.md");
fs.writeFileSync(reading, text);
fs.writeFileSync(writing, text.replace("A quieter page", "Working draft"));
const evaluate = (code: string): DriverStep => ({ eval: `(async () => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const waitFor = async predicate => { const deadline = performance.now() + 20000; while (!predicate()) { if (performance.now() > deadline) throw new Error('Design verification timed out: ' + predicate); await new Promise(r => setTimeout(r, 20)); } };
  ${code}
})()` });
const shot = (name: string): DriverStep => ({ shot: path.join(output, `${name}.png`) });
const viewport = (width: number, height = 700): DriverStep => ({ debug: { method: "Emulation.setDeviceMetricsOverride", params: { width, height, deviceScaleFactor: 1, mobile: false } } });
const steps: DriverStep[] = [
  evaluate(`await window.simplemd.setSettings({theme:'light', themeLight:'editorial-light', themeDark:'editorial-dark'}); await waitFor(() => document.querySelector('#doc h1'));`),
  shot("one-tab-light-read"),
  evaluate(`await window.simplemd.openPath(${JSON.stringify(writing)}, 'edit'); await waitFor(() => document.querySelector('.cm-content')); window.simplemd.command('split-panes'); await waitFor(() => document.querySelectorAll('.document-pane').length === 2); window.simplemd.command('mode-split'); await waitFor(() => document.querySelector('[data-element="preview"] h1')); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));`),
  shot("two-tabs-two-panes-light"),
  evaluate(`await window.simplemd.setSettings({theme:'dark'}); await waitFor(() => document.documentElement.dataset.theme === 'dark');`),
  shot("two-tabs-two-panes-dark"),
  viewport(700),
  evaluate(`await window.simplemd.setSettings({theme:'light'}); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));`),
  shot("narrow-700-two-panes"),
];
if (phase === "after") steps.push(evaluate(`
  const pane = document.querySelector('.document-pane[data-active="true"]');
  const content = pane.querySelector('.cm-content');
  assert(parseFloat(getComputedStyle(content).paddingLeft) >= 24, 'Editor lost its inset');
  assert(document.querySelector('#tabs').getAttribute('role') === 'tablist', 'Tablist role missing');
  assert([...document.querySelectorAll('.tab')].every(t => t.getBoundingClientRect().width < 240), 'Tabs stretch');
  assert(getComputedStyle(pane.querySelector('.mode-menu')).display !== 'none', 'Narrow pane has no mode menu');
  assert(getComputedStyle(pane.querySelector('[data-element="modes"]')).display === 'none', 'Narrow pane still has cramped segments');
  assert(document.documentElement.scrollWidth === innerWidth, 'Window overflows horizontally');
  await new Promise(r => setTimeout(r, 120));
  assert(document.getAnimations().every(a => a instanceof CSSAnimation && /^cm-blink2?$/.test(a.animationName)), 'Decorative motion remains: ' + JSON.stringify(document.getAnimations().map(a => ({name:a.animationName,property:a.transitionProperty,target:a.effect?.target?.className}))));
`));
steps.push(viewport(860));
if (phase === "after") {
  steps.push(evaluate(`
    document.querySelector('.document-pane[data-active="true"] [data-element="modes"] [aria-checked="true"]').focus();
  `), { input: { type: "keyDown", keyCode: "Right" } }, { input: { type: "keyUp", keyCode: "Right" } }, evaluate(`
    const pane = document.querySelector('.document-pane[data-active="true"]');
    await waitFor(() => pane.querySelector('[data-element="edit"]').dataset.mode === 'source');
    assert(document.activeElement.dataset.mode === 'source', 'Radio navigation lost focus');
    const reading = [...document.querySelectorAll('.tab')].find(t => t.querySelector('.tab-name').textContent === 'reading.md');
    await window.simplemd.closeTab(Number(reading.dataset.documentId));
    await waitFor(() => document.querySelector('#stage').dataset.panes === '1');
    assert(document.querySelector('#tabs').hidden, 'One-tab strip is visible');
    assert(document.querySelector('.pane-toolbar').getBoundingClientRect().height === 0, 'Single pane still has a header');
    assert(document.querySelector('.pane-controls').getBoundingClientRect().top < 38, 'Single-pane modes are not in the title bar');
    for (const mode of ['live','split','source']) {
      window.simplemd.command('mode-' + mode);
      await waitFor(() => document.querySelector('[data-element="edit"]').dataset.mode === mode);
      assert(parseFloat(getComputedStyle(document.querySelector('.cm-content')).paddingLeft) >= 24, mode + ' lost editor padding');
    }
    window.designOldWidth = getComputedStyle(document.querySelector('.cm-content')).maxWidth;
    await window.simplemd.setSettings({writingContentWidth:40});
    await waitFor(() => getComputedStyle(document.querySelector('.cm-content')).maxWidth !== window.designOldWidth);
    const content = document.querySelector('.cm-content');
    assert(content.getBoundingClientRect().left > document.querySelector('[data-element="editor-host"]').getBoundingClientRect().left + 24, 'Editor measure is not centered');
    assert(getComputedStyle(content).maxWidth === getComputedStyle(content).width, 'Editor ignored its measure');
    await new Promise(r => setTimeout(r, 200));
    const view = content.cmTile.root.view;
    assert(Math.abs(parseFloat(document.querySelector('.cm-cursor-primary').style.left) + view.scrollDOM.getBoundingClientRect().left - view.scrollDOM.scrollLeft - view.coordsAtPos(view.state.selection.main.head).left) < 2, 'Caret stayed at the old content width: ' + JSON.stringify({content:content.getBoundingClientRect().toJSON(), coords:view.coordsAtPos(view.state.selection.main.head), cursors:[...document.querySelectorAll('.cm-cursor-primary')].map(c=>({rect:c.getBoundingClientRect().toJSON(),style:c.style.cssText,layer:c.parentElement.style.cssText})),panes:document.querySelectorAll('.document-pane').length}));
  `), shot("one-tab-source"));
}
steps.push(evaluate(`await window.simplemd.setSettings({writingContentWidth:66}); window.simplemd.command('preferences');`));
for (const theme of ["light", "dark"]) steps.push({ settings: [
  evaluate(`await waitFor(() => document.querySelector('#reading-font-family option')); await window.simplemdSettings.set({theme:${JSON.stringify(theme)}});`),
  { debug: { method: "Emulation.setEmulatedMedia", params: { features: [{ name: "prefers-color-scheme", value: theme }] } } },
  viewport(540, 1600),
  ...(phase === "after" ? [evaluate(`
    assert([...document.querySelectorAll('legend')].map(l => l.textContent).join(',') === 'Appearance,Reading,Writing,Code,Behavior,Advanced', 'Settings grouping differs');
    assert(document.querySelector('label[for="appearance"]').textContent === 'Color scheme', 'Duplicate Appearance label');
    assert(document.querySelectorAll('input[role="switch"]').length === 6, 'Switches missing');
    assert([...document.querySelectorAll('input,select')].every(c => c.labels.length && c.tabIndex >= 0), 'Unlabeled or unreachable setting');
  `)] : []),
  shot(`settings-${theme}`),
] });
const drive = path.join(output, "drive.json");
function settleCaptures(sequence: DriverStep[]): DriverStep[] {
  return sequence.flatMap(step => "shot" in step ? [{ wait: 200 }, step]
    : "settings" in step ? [{ settings: settleCaptures(step.settings) }] : [step]);
}
fs.writeFileSync(drive, JSON.stringify(settleCaptures(steps), null, 2));
const executable = path.join(appRoot, "node_modules/electron/dist", fs.readFileSync(path.join(appRoot, "node_modules/electron/path.txt"), "utf8").trim());
const env = { ...process.env, SMD_USER_DATA: profile, SMD_DRIVE: drive, SMD_INTENT: "read" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [appRoot, reading], { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", data => { logs += String(data); });
child.stderr.on("data", data => { logs += String(data); });
const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
try {
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  fs.writeFileSync(path.join(output, "electron.log"), logs);
  assert.equal(code, 0, logs);
  for (const name of ["one-tab-light-read", "two-tabs-two-panes-light", "two-tabs-two-panes-dark", "narrow-700-two-panes", "settings-light", "settings-dark"]) assert(fs.statSync(path.join(output, `${name}.png`)).size > 100);
  assert.equal(fs.readFileSync(reading, "utf8"), text);
  assert.equal(fs.readFileSync(writing, "utf8"), text.replace("A quieter page", "Working draft"));
  console.log(`PASS design ${phase}: ${output}`);
} finally { clearTimeout(timeout); }

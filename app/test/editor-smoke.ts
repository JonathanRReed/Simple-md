import { mkdtemp, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = await mkdtemp(path.join(tmpdir(), "simple-md-renderer-"));
const root = path.resolve(import.meta.dir, "..");
const result = await Bun.build({ entrypoints: [path.join(root, "src/renderer/app.ts"), path.join(root, "src/renderer/editor.ts"), path.join(root, "src/renderer/ui.ts")], outdir: out, target: "browser", format: "esm", splitting: true });
if (!result.success) throw new Error(result.logs.join("\n"));
for (const file of ["index.html", "style.css", "motion.css"]) await cp(path.join(root, "src/renderer", file), path.join(out, file));
await cp(path.join(root, "node_modules/katex/dist/katex.min.css"), path.join(out, "katex.min.css"));
await cp(path.join(root, "node_modules/katex/dist/fonts"), path.join(out, "fonts"), { recursive: true });
const checks = process.argv[2] ? await Bun.file(process.argv[2]).text() : `
await command('toggle-edit');
await until(() => document.querySelector('.cm-content'));
assert(!document.querySelector('#edit').hidden, 'Markdown enters edit mode');
`;
const fixture = `
const {ipcRenderer} = require("electron");
const listeners = {};
const pending = [];
const settings = { theme: 'light', mode: 'source', autosave: false, launchAtLogin: false, vim: false, spellcheck: true, zoom: 1, width: 'normal', typeface: 'sans', recents: [] };
const calls = { dirty: [], saved: [], opened: [], images: [] };
const blocks = text => [{ key: text, html: '<p>' + text.replaceAll('&', '&amp;').replaceAll('<', '&lt;') + '</p>' }];
window.simplemd = {
 ready: async () => ({settings:{...settings}, platform:'linux'}),
 onTransition: cb => listeners.transition = cb,
 onDoc: cb => listeners.doc = cb, onSettings: cb => listeners.settings = cb, onSaved: cb => listeners.saved = cb,
 onCommand: cb => listeners.command = cb, onDiskChanged: cb => listeners.disk = cb,
 onFlushRequest: cb => listeners.flush = cb, onPrintDoc: () => {}, flushResponse: (id, value) => window.flushed = value,
 editing: id => calls.editing = id,
 setDirty: (value, id) => calls.dirty.push([value,id]), documentReady: id => calls.ready = id,
 renderBlocks: async text => ({title: text, blocks: blocks(text)}), renderFragment: async text => '<pre>' + text + '</pre>',
 save: (text, dialog, id) => new Promise(resolve => pending.push({text, dialog, id, resolve})),
 saveImage: async () => 'assets/image (1).png', acceptDisk: async () => true,
 setSettings: async patch => {Object.assign(settings, patch); listeners.settings({...settings})},
 openPath: async p => calls.opened.push(p), openLink: async () => {}, command: cmd => calls.command = cmd, hide: () => {}, pathForFile: () => '',
 exportPdf: async () => {}, exportHtml: async () => {}, print: async () => {}, openDialog: async () => {calls.openDialog = (calls.openDialog ?? 0) + 1}
};
window.fixture = { listeners, pending, settings, calls, blocks, screenshot: name => ipcRenderer.invoke("fixture:screenshot", name), key: (key, modifiers = []) => ipcRenderer.invoke("fixture:key", key, modifiers) };
`;
await writeFile(path.join(out, "preload.cjs"), fixture);
const runner = `
const {app,BrowserWindow,ipcMain} = require("electron");
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(path.join(out, "profile"))});
setTimeout(() => {console.error("Renderer smoke timed out"); process.exit(1)}, 45000);
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false, width:1100, height:760, webPreferences:{preload:${JSON.stringify(path.join(out,"preload.cjs"))}, contextIsolation:false, sandbox:false, offscreen:true, backgroundThrottling:false}});
 ipcMain.handle("fixture:screenshot", async (_event, name) => {
  if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid screenshot name");
  fs.writeFileSync(${JSON.stringify(out)} + "/" + name + ".png", (await win.webContents.capturePage()).toPNG());
 });
 ipcMain.handle("fixture:key", (_event, key, modifiers) => {
  win.webContents.sendInputEvent({type:"keyDown",keyCode:key,modifiers});
  win.webContents.sendInputEvent({type:"keyUp",keyCode:key,modifiers});
 });
 try {
  win.webContents.on("console-message", (_event, ...details) => fs.appendFileSync(${JSON.stringify(path.join(out,"console.jsonl"))}, JSON.stringify(details) + String.fromCharCode(10)));
  await win.loadFile(${JSON.stringify(path.join(out,"index.html"))});
  fs.writeFileSync(${JSON.stringify(path.join(out,"empty-state.png"))}, (await win.webContents.capturePage()).toPNG());
  const result = await win.webContents.executeJavaScript(
   ${JSON.stringify(`(async () => {
const {listeners,pending,settings,calls,blocks} = fixture;
const receipts = [];
const assert = (value, name) => { if (!value) throw new Error(name); receipts.push(name); console.log(name); };
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const until = async predicate => { for(let n=0;n<150;n++){if(predicate())return;await wait(20)}throw new Error('Timed out waiting for UI'); };
const command = async name => {listeners.command(name);await wait(40)};
const doc = async (text, name='a.md', id=1, intent='read', html=null) => {listeners.doc({documentId:id,path:'/tmp/'+name,name,text,title:name,intent,baseUrl:'file:///tmp/',blocks:html ?? blocks(text)});await wait(60)};
await until(() => listeners.command);
document.querySelector('#open-file').click();
document.querySelector('#new-note').click();
assert(calls.openDialog === 1, 'empty-state Open file opens the existing file chooser');
assert(calls.command === 'new', 'empty-state New note invokes the existing new-note command');
assert(document.querySelector('#open-hint').textContent.includes('choose a file'), 'Linux shortcut hint describes the chooser');
await doc('first');
${checks}
return receipts;
})()`)});
  fs.writeFileSync(${JSON.stringify(path.join(out,"receipts.json"))}, JSON.stringify(result,null,2));
  fs.writeFileSync(${JSON.stringify(path.join(out,"screenshot.png"))}, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({out, receipts:result}));
  fs.writeFileSync(${JSON.stringify(path.join(out,"completed"))}, "ok");
  process.exit(0);
 } catch(error) { console.error(error); process.exit(1); }
});
`.replace("{out, receipts:result}", `{out:${JSON.stringify(out)}, receipts:result}`);
await writeFile(path.join(out,"runner.cjs"), runner);
const executable = process.platform === "darwin" ? path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron") : process.platform === "win32" ? path.join(root, "node_modules/electron/dist/electron.exe") : path.join(root, "node_modules/electron/dist/electron");
const stdoutFile = Bun.file(path.join(out, "stdout.log"));
const stderrFile = Bun.file(path.join(out, "stderr.log"));
const proc = Bun.spawn([executable, path.join(out,"runner.cjs")], {stdout:stdoutFile,stderr:stderrFile,env:{...process.env, ELECTRON_RUN_AS_NODE:""}});
let completed = false;
const completion = path.join(out, "completed");
const cleanup = setInterval(() => {
  if (existsSync(completion)) {
    completed = true;
    proc.kill("SIGKILL");
  }
}, 100);
const timer = setTimeout(() => proc.kill("SIGKILL"), 60000);
const code = await proc.exited;
clearInterval(cleanup);
clearTimeout(timer);
completed ||= existsSync(completion);
const [stdout, stderr] = await Promise.all([stdoutFile.text(), stderrFile.text()]);
process.stdout.write(stdout);
if (!completed) { process.stderr.write(stderr); process.exit(code || 1); }
if (code !== 0) process.stdout.write("Isolated renderer process stopped after all receipts were written.\n");

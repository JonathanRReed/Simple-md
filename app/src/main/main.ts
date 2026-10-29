import { resolveAuthorUrl } from "../shared/url-resolver.js";
import { urlContext } from "./document-urls.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
} from "electron";
import type {
  Command,
  DocPayload,
  FlushResult,
  OpenIntent,
  Settings,
  SaveResult,
} from "../shared/types.js";
import { FileConflictError, isMarkdown, isPeekable, readDiskText, saveImageNextTo, watchDocument, writeAtomic } from "./files.js";
import { DocumentQueue, openPreparedDocument, quitAfterSettle, settleDocument } from "./lifecycle.js";
import { embedKatexFonts, embedLocalImages, EXPORT_LIGHT_THEME } from "./export-html.js";
import { replaceShortcut } from "./shortcuts.js";
import { runDriver } from "./driver.js";
import { perfMark } from "./perf.js";
import { disposeRenderer, prefetchBlocks, renderBlocks, renderFragment, warmUp } from "./render-client.js";
import { getCachedRender, setCachedRender } from "./render-cache.js";
import { buildMenu } from "./menu.js";
import { PeekHelper, type PeekRequest } from "./peek.js";
import { getFileManagerSelection } from "./selection.js";
import { flushSettings, loadSettings, patchSettings, saveSettings } from "./settings.js";

// Dev-only launch profiler: SMD_TRACE=1 prints where startup time goes.
const T0 = performance.now();
const tracing = !!process.env.SMD_TRACE;
const trace = (mark: string) => {
  if (tracing) console.error(`trace ${mark}: ${(performance.now() - T0).toFixed(0)}ms`);
};
trace("main-bundle-loaded");

app.setName("SimpleMD");

const testProfile = !app.isPackaged && !!process.env.SMD_USER_DATA;
if (testProfile) app.setPath("userData", path.resolve(process.env.SMD_USER_DATA!));
else app.setPath("userData", path.join(app.getPath("appData"), app.name));

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, "renderer", "index.html");

interface Current {
  documentId: number;
  intent: OpenIntent;
  path: string | null;
  name: string;
  /** Last disk revision accepted by the renderer or written by this process. */
  diskText: string | null;
  conflict: boolean;
}

let settings: Settings = { ...loadSettings() };
let win: BrowserWindow;
let tray: Tray | undefined;
let helper: PeekHelper | undefined;
let current: Current = { documentId: 0, intent: "edit", path: null, name: "Untitled", diskText: null, conflict: false };
const documents = new DocumentQueue();
let documentSeq = 0;
let watcher: { close(): void } | undefined;
let rendererReady = false;
let markRendererLoaded: () => void;
// Documents opened during startup wait here so they are not sent to a page that has not loaded.
const rendererLoaded = new Promise<void>((resolve) => (markRendererLoaded = resolve));
let quitting = false;
let dirty = false;

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

// ───────── settings ─────────

function applySettings(patch: unknown): void {
  const prev = settings;
  const next = patchSettings(settings, patch);
  if (next.shortcut !== prev.shortcut && !testProfile) {
    replaceShortcut(prev.shortcut, next.shortcut, globalShortcut, () => void togglePeek());
  }
  settings = next;
  nativeTheme.themeSource = settings.theme;
  if (settings.spacePreview !== prev.spacePreview) syncPeekHelper();
  if (settings.launchAtLogin !== prev.launchAtLogin) applyLoginItem();
  if (settings.spellcheck !== prev.spellcheck) session.defaultSession.setSpellCheckerEnabled(settings.spellcheck);
  saveSettings(settings);
  send("smd:settings", settings);
  refreshMenus();
}

function refreshMenus(): void {
  buildMenu({
    settings: () => settings,
    command: (cmd) => runCommand(cmd),
    openDialog: () => void openDialog(),
    openPath: (p) => void openFile(p, "edit"),
    patch: applySettings,
    quit: () => app.quit(),
  });
  tray?.setContextMenu(trayMenu());
}

function addRecent(file: string): void {
  if (!testProfile) app.addRecentDocument(file);
  applySettings({ recents: [file, ...settings.recents.filter((p) => p !== file)].slice(0, 12) });
}

// ───────── window ─────────

function restoredBounds(): Partial<Electron.Rectangle> {
  const b = settings.bounds;
  if (!b) return {};
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y >= w.y - 20 && b.y < w.y + w.height - 80;
  });
  return visible ? b : { width: b.width, height: b.height };
}

// Windows and Linux keep their own window buttons, drawn over our title bar.
function overlayColors(): { color: string; symbolColor: string; height: number } {
  return {
    color: "#00000000",
    symbolColor: nativeTheme.shouldUseDarkColors ? "#c8c8cc" : "#55555c",
    height: 38,
  };
}

function createWindow(): BrowserWindow {
  const mac = process.platform === "darwin";
  const w = new BrowserWindow({
    width: 860,
    height: 700,
    minWidth: 420,
    minHeight: 320,
    ...restoredBounds(),
    // Shown immediately below: the skeleton paints while the first document renders.
    show: false,
    title: "SimpleMD",
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    titleBarOverlay: mac ? undefined : overlayColors(),
    trafficLightPosition: mac ? { x: 16, y: 13 } : undefined,
    vibrancy: mac ? "under-window" : undefined,
    backgroundColor: mac ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#161617" : "#fcfcfb",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  if (!mac) {
    nativeTheme.on("updated", () => {
      if (!w.isDestroyed()) w.setTitleBarOverlay(overlayColors());
    });
  }
  if (!settings.bounds) w.center();
  void w.loadFile(INDEX);

  w.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    openLink(url);
  });

  let boundsTimer: NodeJS.Timeout | undefined;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (w.isDestroyed() || w.isMaximized() || w.isFullScreen() || w.isMinimized()) return;
      applySettings({ bounds: w.getBounds() });
    }, 400);
  };
  // Space must pass straight through while our own window is the one being typed in.
  w.on("focus", () => {
    trace("win-focus");
    helper?.setEnabled(false);
  });
  w.on("blur", () => {
    trace("win-blur");
    helper?.setEnabled(true);
  });
  w.on("hide", () => {
    trace("win-hide");
    helper?.setEnabled(true);
  });
  w.on("show", () => trace("win-show"));
  w.on("resize", rememberBounds);
  w.on("move", rememberBounds);

  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    void hideWindow();
  });
  return w;
}

function hideWindow(): Promise<void> {
  return documents.run(() => transition(hideCurrentWindow));
}

async function hideCurrentWindow(): Promise<void> {
  trace("hide-requested");
  if (await settle()) {
    win.hide();
    if (process.platform === "darwin") app.dock?.hide();
    trace("hide-done");
  } else {
    trace("hide-cancelled");
  }
}

// ───────── renderer round trips ─────────

const flushWaiters = new Map<number, (r: FlushResult | null) => void>();
let flushSeq = 0;

function requestFlush(): Promise<FlushResult | null> {
  return new Promise((resolve) => {
    if (!rendererReady || win.isDestroyed()) return resolve(null);
    const id = ++flushSeq;
    const timer = setTimeout(() => {
      flushWaiters.delete(id);
      resolve(null);
    }, 1500);
    flushWaiters.set(id, (r) => {
      clearTimeout(timer);
      flushWaiters.delete(id);
      if (r?.documentId === current.documentId && r.conflict) current.conflict = true;
      resolve(r);
    });
    send("smd:flush-request", id);
  });
}

/** Saves or discards pending edits before the window changes document or hides. False means the user cancelled. */
async function transition<T>(operation: () => Promise<T>): Promise<T> {
  send("smd:transition", true);
  try {
    return await operation();
  } finally {
    send("smd:transition", false);
  }
}

async function settle(): Promise<boolean> {
  await rendererLoaded;
  return settleDocument({
    documentId: current.documentId,
    autosave: settings.autosave,
    hasPath: current.path !== null,
    flush: requestFlush,
    save: async (text) => (await saveText(text, false, current.documentId)) !== null,
    choose: async () => {
      reveal("edit");
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        message: `Save changes to “${current.name}”?`,
        detail: "Your changes will be lost if you don't save them.",
        buttons: ["Save", "Don't Save", "Cancel"],
        defaultId: 0,
        cancelId: 2,
      });
      return response === 0 ? "save" : response === 1 ? "discard" : "cancel";
    },
  });
}

// ───────── documents ─────────

const baseUrlOf = (file: string | null) =>
  file ? pathToFileURL(path.dirname(file)).href.replace(/\/?$/, "/") : null;

async function payloadFor(file: string | null, text: string, intent: OpenIntent, fromDisk = false): Promise<DocPayload> {
  let title: string;
  let blocks: DocPayload["blocks"];
  if (intent === "edit" && settings.mode === "source" && path.extname(file ?? "").toLowerCase() !== ".mdx") {
    title = file ? path.basename(file) : "Untitled";
    blocks = [];
  } else if (file && fromDisk) {
    const stat = await fs.promises.stat(file).catch(() => null);
    perfMark("read-and-hash-start", { path: file });
    const hit = stat && getCachedRender(file, stat.mtimeMs, stat.size, text);
    perfMark("read-and-hash-end", { path: file, diskRenderCache: hit ? "hit" : "miss" });
    if (hit) {
      ({ title, blocks } = hit);
    } else {
      ({ title, blocks } = await renderBlocks(text, file));
      if (stat) setCachedRender(file, stat.mtimeMs, stat.size, title, blocks, text);
    }
  } else {
    ({ title, blocks } = await renderBlocks(text, file));
  }
  return {
    documentId: current.documentId,
    path: file,
    name: file ? path.basename(file) : "Untitled",
    text,
    blocks,
    title,
    intent,
    baseUrl: baseUrlOf(file),
  };
}

function updateTitle(): void {
  if (win.isDestroyed()) return;
  win.setTitle(`${current.name}${dirty ? " (Edited)" : ""} | SimpleMD`);
  win.setDocumentEdited(dirty);
  if (current.path) win.setRepresentedFilename(current.path);
}

function watch(file: string | null): void {
  watcher?.close();
  watcher = undefined;
  if (!file) return;
  const documentId = current.documentId;
  try {
    const changed = () => {
      void readDiskText(file).then((text) => {
        if (current.documentId !== documentId || text === null || text === current.diskText) return;
        current.conflict = true;
        send("smd:disk-changed", text, documentId);
      }).catch((err) => console.error("simple-md: could not read changed note", err));
    };
    watcher = watchDocument(file, changed);
    changed();
  } catch (err) {
    console.error("simple-md: could not watch note", err);
  }
}

const documentWaiters = new Map<number, () => void>();
async function present(payload: DocPayload): Promise<void> {
  await rendererLoaded;
  payload.documentId = ++documentSeq;
  current = { documentId: payload.documentId, intent: payload.intent, path: payload.path, name: payload.name, diskText: payload.path ? payload.text : null, conflict: false };
  dirty = false;
  watch(payload.path);
  updateTitle();
  const usable = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      documentWaiters.delete(payload.documentId);
      reject(new Error("The document did not finish loading."));
    }, 15_000);
    documentWaiters.set(payload.documentId, () => {
      clearTimeout(timer);
      documentWaiters.delete(payload.documentId);
      trace(`document-usable id=${payload.documentId} name=${payload.name}`);
      resolve();
    });
  });
  perfMark("renderer-send", { path: payload.path, documentId: payload.documentId });
  send("smd:doc", payload);
  trace(`doc-sent name=${payload.name} blocks=${payload.blocks.length} intent=${payload.intent}`);
  await usable;
}

function reveal(intent: OpenIntent = current.intent): void {
  if (process.platform === "darwin") {
    if (intent === "edit") void app.dock?.show();
    else app.dock?.hide();
  }
  // An accessory (dock-hidden) app's win.focus() orders the window front but does NOT activate
  // the app: the window floats over Finder without key focus, keyboard input keeps going to
  // Finder, and the tap keeps swallowing Space. app.focus({ steal }) is the activation step.
  if (process.platform === "darwin") app.focus({ steal: true });
  if (!win.isVisible()) win.show();
  win.focus();
}

function openFile(file: string | undefined, intent: OpenIntent, valid = async () => true): Promise<boolean> {
  return documents.run(() => openCurrentFile(file, intent, valid));
}

async function openCurrentFile(file: string | undefined, intent: OpenIntent, valid = async () => true): Promise<boolean> {
  if (!file) {
    if (!(await valid())) return false;
    reveal(intent);
    return true;
  }
  if (!isMarkdown(file)) return false;
  const abs = path.resolve(file);
  perfMark("file-open-arrival", { path: abs });
  try {
    return await openPreparedDocument({
      valid,
      prepare: async () => {
        perfMark("read-start", { path: abs });
        const text = await fs.promises.readFile(abs, "utf8");
        perfMark("read-end", { path: abs });
        return payloadFor(abs, text, intent, true);
      },
      transition,
      settle,
      refresh: async (payload) => {
        const latest = await fs.promises.readFile(abs, "utf8");
        return latest === payload.text ? payload : payloadFor(abs, latest, intent, true);
      },
      present: async (payload) => {
        reveal(intent);
        await present(payload);
        addRecent(abs);
      },
    });
  } catch (err) {
    if (!(await valid())) return false;
    console.error("simple-md: failed to open", abs, err);
    void dialog.showMessageBox(win, { type: "error", message: `Couldn’t open “${path.basename(abs)}”.`, detail: String(err) });
    return false;
  }
}

function newDoc(): Promise<void> {
  return documents.run(() => transition(async () => {
    if (!(await settle())) return;
    reveal("edit");
    await present(await payloadFor(null, "", "edit"));
  }));
}

function openDialog(): Promise<boolean> {
  return documents.run(async () => {
    reveal("edit");
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mdx", "txt"] }],
    });
    if (res.canceled || !res.filePaths[0]) return false;
    return openCurrentFile(res.filePaths[0], "edit");
  });
}

async function saveText(text: string, forceDialog: boolean, documentId: number): Promise<SaveResult | null> {
  if (documentId !== current.documentId || (current.conflict && !forceDialog)) return null;
  let target = current.path;
  if (!target || forceDialog) {
    const res = await dialog.showSaveDialog(win, {
      defaultPath: current.path ?? path.join(app.getPath("documents"), `${current.name.replace(/\.[^.]+$/, "")}.md`),
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  try {
    const expected = target === current.path ? current.diskText : await readDiskText(target);
    await writeAtomic(target, text, expected);
  } catch (err) {
    if (err instanceof FileConflictError) {
      current.conflict = true;
      const external = await readDiskText(target).catch(() => null);
      if (external !== null) send("smd:disk-changed", external, documentId);
      return null;
    }
    void dialog.showMessageBox(win, { type: "error", message: `Couldn’t save “${path.basename(target)}”.`, detail: String(err) });
    return null;
  }
  const moved = target !== current.path;
  current = { ...current, path: target, name: path.basename(target), diskText: text, conflict: false };
  if (moved) {
    watch(target);
    addRecent(target);
  }
  updateTitle();
  const result = { documentId, path: target, name: current.name, baseUrl: baseUrlOf(target)!, text };
  send("smd:saved", result);
  return result;
}

// ───────── links & commands ─────────

async function openLink(href: string, intent: OpenIntent = "edit"): Promise<boolean> {
  if (/^(https?:|mailto:)/i.test(href)) {
    await shell.openExternal(href);
    return false;
  }
  if (!current.path) return false;
  const resolved = href.startsWith("file:") ? href : resolveAuthorUrl(href, "anchor", urlContext(path.dirname(current.path)));
  if (!resolved || !resolved.startsWith("file:")) return false;
  try {
    const target = fileURLToPath(resolved);
    return isMarkdown(target) ? openFile(target, intent) : false;
  } catch {
    return false;
  }
}

function runCommand(cmd: Command): void {
  switch (cmd) {
    case "preferences":
      reveal("edit");
      void rendererLoaded.then(() => send("smd:cmd", "preferences"));
      return;
    case "new":
      void newDoc();
      return;
    case "reveal":
      if (current.path) shell.showItemInFolder(current.path);
      return;
    case "mode-live":
    case "mode-split":
    case "mode-source":
      reveal("edit");
      applySettings({ mode: cmd.slice(5) as Settings["mode"] });
      send("smd:cmd", cmd);
      return;
    case "zoom-in":
    case "zoom-out":
    case "zoom-reset":
      applySettings({ zoom: cmd === "zoom-reset" ? 1 : settings.zoom + (cmd === "zoom-in" ? 0.1 : -0.1) });
      return;
    default:
      reveal(cmd === "toggle-edit" ? "edit" : current.intent);
      send("smd:cmd", cmd);
  }
}

// ───────── export & print ─────────

const printWaiters = new Map<number, (error?: string) => void>();

async function withPrintWindow<T>(text: string, use: (w: BrowserWindow, doc: DocPayload) => Promise<T>): Promise<T> {
  const doc = await payloadFor(current.path, text, "peek");
  const pw = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  const id = pw.webContents.id;
  let timer: NodeJS.Timeout | undefined;
  try {
    await pw.loadFile(INDEX, { query: { print: "1" } });
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The print preview did not finish loading.")), 15_000);
      pw.webContents.once("render-process-gone", () => reject(new Error("The print renderer stopped.")));
      pw.once("closed", () => reject(new Error("The print window closed.")));
      printWaiters.set(id, (error) => error ? reject(new Error(error)) : resolve());
    });
    pw.webContents.send("smd:print-doc", doc, settings);
    await ready;
    return await use(pw, doc);
  } finally {
    clearTimeout(timer);
    printWaiters.delete(id);
    if (!pw.isDestroyed()) pw.destroy();
  }
}

function makePdf(text: string): Promise<Buffer> {
  return withPrintWindow(text, (pw) =>
    pw.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } }),
  );
}

async function exportPdf(text: string): Promise<void> {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(current.path ? path.dirname(current.path) : app.getPath("documents"), `${current.name.replace(/\.[^.]+$/, "")}.pdf`),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (res.canceled || !res.filePath) return;
  await fs.promises.writeFile(res.filePath, await makePdf(text));
  shell.showItemInFolder(res.filePath);
}

async function exportHtml(text: string): Promise<void> {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(current.path ? path.dirname(current.path) : app.getPath("documents"), `${current.name.replace(/\.[^.]+$/, "")}.html`),
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (res.canceled || !res.filePath) return;
  await fs.promises.writeFile(res.filePath, await makeHtml(text));
  shell.showItemInFolder(res.filePath);
}

async function makeHtml(text: string): Promise<string> {
  const { title, html } = await withPrintWindow(text, async (pw, doc) => {
    const sources: unknown = await pw.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#doc img'), image => image.src)`);
    if (!Array.isArray(sources) || !sources.every((source): source is string => typeof source === "string")) throw new Error("Invalid export images.");
    const embedded = await embedLocalImages(sources, (file) => fs.promises.readFile(file));
    const html: unknown = await pw.webContents.executeJavaScript(`(() => {
      const clone = document.querySelector('#doc').cloneNode(true);
      const sources = ${JSON.stringify(embedded)};
      clone.querySelectorAll('img').forEach((image, index) => { image.src = sources[index]; image.removeAttribute('loading'); });
      return clone.innerHTML;
    })()`);
    if (typeof html !== "string") throw new Error("Invalid export document.");
    return { title: doc.title, html };
  });
  const dir = path.join(here, "renderer");
  const css = await fs.promises.readFile(path.join(dir, "style.css"), "utf8");
  const katex = await embedKatexFonts(
    await fs.promises.readFile(path.join(dir, "katex.min.css"), "utf8"),
    (relativePath) => fs.promises.readFile(path.join(dir, relativePath)),
  );
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="SimpleMD" />
<title>${esc(title)}</title>
<style>${css}</style>
<style>${katex}</style>
<style>
${EXPORT_LIGHT_THEME}
/* Static-document overrides: no app chrome, no fixed layout. */
html, body { height: auto; }
body { display: block; overflow: visible; background: #fff; color: #242426; }
.titlebar, #banner, #findbar, #picker, #toast, .copy-code, #edit, #empty, details.frontmatter { display: none !important; }
#stage, .pane, .scroller { position: static; display: block; height: auto; overflow: visible; padding: 0; }
.block { content-visibility: visible; }
</style>
</head>
<body>
<main id="stage"><section id="read" class="pane"><div class="scroller"><article class="prose">
${html}
</article></div></section></main>
</body>
</html>
`;
}

async function printDoc(text: string): Promise<void> {
  await withPrintWindow(
    text,
    (pw) => new Promise<void>((resolve, reject) => pw.webContents.print({ printBackground: true }, (ok, reason) => ok ? resolve() : reject(new Error(reason || "Printing was cancelled.")))),
  );
}

// ───────── peek, tray, shortcut ─────────

async function togglePeek(): Promise<void> {
  if (win.isVisible() && win.isFocused()) {
    await hideWindow();
    return;
  }
  const picked = (await getFileManagerSelection()).find(isMarkdown);
  if (picked) await openFile(picked, "peek");
  else await openDialog();
}

let automationDenied = false;
const automationPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

// The helper is holding a Space keypress. Markdown opens in peek; anything else gets the key back so
// Quick Look and friends behave exactly as if SimpleMD were not installed.
async function onSpacePressed(request: PeekRequest): Promise<void> {
  trace(`peek-received paths=${request.paths.length}`);
  try {
    const picked = request.paths.find(isPeekable);
    if (picked && await openFile(picked, "peek", request.validate)) return;
    trace("peek-replayed");
    request.replay();
  } catch {
    request.replay();
  } finally {
    request.complete();
  }
}

const accessibilityPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

// Renders files the file manager has selected, before Space is pressed. Bounded and best-effort.
const prewarmed = new Set<string>();
async function prewarm(paths: string[]): Promise<void> {
  for (const p of paths.filter(isPeekable).slice(0, 3)) {
    if (prewarmed.has(p) || p === current.path) continue;
    prewarmed.add(p);
    try {
      const stat = await fs.promises.stat(p);
      if (stat.size > 8 * 1024 * 1024) continue;
      const text = await fs.promises.readFile(p, "utf8");
      if (getCachedRender(p, stat.mtimeMs, stat.size, text)) continue;
      const rendered = await prefetchBlocks(text, p);
      if (!rendered) continue;
      const { title, blocks } = rendered;
      setCachedRender(p, stat.mtimeMs, stat.size, title, blocks, text);
      trace("prewarmed");
    } catch {
      prewarmed.delete(p);
    }
  }
  if (prewarmed.size > 64) prewarmed.clear();
}

async function explainPermission(): Promise<void> {
  if (settings.peekPrompted) return;
  applySettings({ peekPrompted: true });
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: "Preview Markdown with Space",
    detail:
      "Select a Markdown file in Finder and press Space to preview it here. Everything else works as usual.\n\nThis needs Accessibility access to read Finder selection and notice Space. The Command-Shift-Space fallback may separately request Finder Automation access.",
    buttons: ["Open System Settings", "Not Now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) void shell.openExternal(accessibilityPane);
}

function applyLoginItem(): void {
  if (!app.isPackaged || testProfile) return;
  if (process.platform === "linux") {
    const dir = path.join(app.getPath("home"), ".config", "autostart");
    const desktop = path.join(dir, "simplemd.desktop");
    try {
      if (settings.launchAtLogin) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          desktop,
          `[Desktop Entry]\nType=Application\nName=SimpleMD\nExec=\"${process.execPath}\" --background\nX-GNOME-Autostart-enabled=true\n`,
        );
      } else {
        fs.rmSync(desktop, { force: true });
      }
    } catch (err) {
      console.error("simple-md: could not update autostart entry", err);
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ["--background"] });
}

function syncPeekHelper(): void {
  if (testProfile || process.platform !== "darwin" || !settings.spacePreview) {
    helper?.stop();
    helper = undefined;
    refreshMenus();
    return;
  }
  if (helper) return;
  helper = new PeekHelper({
    onPeek: (request) => void onSpacePressed(request),
    onSelection: (paths) => void prewarm(paths),
    onAutomationDenied: () => {
      automationDenied = true;
      refreshMenus();
    },
    onPermission: (state) => {
      if (state === "missing") void explainPermission();
      refreshMenus();
    },
  });
  helper.start();
}

function registerShortcut(): void {
  if (testProfile) return;
  try {
    replaceShortcut(null, settings.shortcut, globalShortcut, () => void togglePeek());
  } catch (err) {
    console.error("simple-md: could not register shortcut", err);
  }
}

function trayMenu(): Electron.Menu {
  const radio = <K extends keyof Settings>(label: string, key: K, value: Settings[K]) => ({
    label,
    type: "radio" as const,
    checked: settings[key] === value,
    click: () => applySettings({ [key]: value } as Partial<Settings>),
  });
  return Menu.buildFromTemplate([
    { label: "Preferences…", click: () => runCommand("preferences") },
    { type: "separator" },
    { label: "New Note", click: () => runCommand("new") },
    { label: "Open…", click: () => void openDialog() },
    { type: "separator" },
    {
      label: "Editing Mode",
      submenu: [radio("Live Preview", "mode", "live"), radio("Split", "mode", "split"), radio("Source", "mode", "source")],
    },
    {
      label: "Appearance",
      submenu: [radio("System", "theme", "system"), radio("Light", "theme", "light"), radio("Dark", "theme", "dark")],
    },
    ...peekMenuItems(),
    { type: "separator" },
    { label: "Quit SimpleMD", click: () => app.quit() },
  ]);
}

function peekMenuItems(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = process.platform === "linux" ? [] : process.platform === "win32"
    ? [{ type: "separator" }, { label: "Space preview unavailable on Windows", enabled: false }]
    : [
      { type: "separator" },
      {
        label: "Preview with Space in Finder",
        type: "checkbox",
        checked: settings.spacePreview,
        click: (item) => applySettings({ spacePreview: item.checked }),
      },
    ];
  if (settings.spacePreview && helper?.permission === "missing") {
    items.push({ label: "Grant Accessibility Access…", click: () => void shell.openExternal(accessibilityPane) });
  }
  items.push({
    label: "Launch at Login",
    type: "checkbox",
    checked: settings.launchAtLogin,
    click: (item) => applySettings({ launchAtLogin: item.checked }),
  });
  if (settings.spacePreview && automationDenied) {
    items.push({ label: "Allow Finder Access…", click: () => void shell.openExternal(automationPane) });
  }
  return items;
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(here, "assets", "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("SimpleMD");
  tray.setContextMenu(trayMenu());
  tray.on("click", () => void togglePeek());
}

// ───────── ipc ─────────

function mainSender(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame;
}

function ipcText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected text.");
  return value;
}

function ipcDocument(value: unknown): number {
  if (value !== current.documentId) throw new Error("This document has been replaced.");
  return current.documentId;
}

function ipcIntent(value: unknown): OpenIntent {
  if (value === undefined || value === "edit") return "edit";
  if (value === "peek") return "peek";
  throw new TypeError("Unsupported open intent.");
}

function registerIpc(): void {
  const handle = (channel: string, use: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      if (!mainSender(e)) throw new Error("Untrusted IPC sender.");
      return use(...args);
    });
  };
  handle("smd:ready", () => {
    trace("renderer-ready");
    rendererReady = true;
    markRendererLoaded();
    return { settings, platform: process.platform, performanceTracing: testProfile && process.env.SMD_PERF === "1" };
  });
  ipcMain.on("smd:editing", (e, id: unknown) => {
    if (!mainSender(e) || id !== current.documentId) return;
    current.intent = "edit";
    if (process.platform === "darwin") void app.dock?.show();
  });
  ipcMain.on("smd:perf-marker", (e, id: unknown, marker: unknown) => {
    if (testProfile && mainSender(e) && id === current.documentId && typeof marker === "string" &&
        ["renderer-receive", "renderer-mount", "first-readable", "fully-highlighted", "diagrams-ready", "ready-for-input"].includes(marker)) {
      perfMark(marker, { documentId: id, path: current.path });
    }
  });
  ipcMain.on("smd:document-ready", (e, id: unknown) => {
    if (mainSender(e) && typeof id === "number" && id === current.documentId) documentWaiters.get(id)?.();
  });
  ipcMain.on("smd:flush-response", (e, id: unknown, r: unknown) => {
    if (!mainSender(e) || typeof id !== "number" || !r || typeof r !== "object") return;
    if (!("text" in r) || typeof r.text !== "string" || !("dirty" in r) || typeof r.dirty !== "boolean" ||
        !("documentId" in r) || typeof r.documentId !== "number" || !("conflict" in r) || typeof r.conflict !== "boolean") return;
    flushWaiters.get(id)?.({ text: r.text, dirty: r.dirty, documentId: r.documentId, conflict: r.conflict });
  });
  ipcMain.on("smd:dirty", (e, value: unknown, id: unknown) => {
    if (!mainSender(e) || id !== current.documentId || typeof value !== "boolean") return;
    dirty = value;
    updateTitle();
  });
  handle("smd:render-blocks", async (value, id) => {
    const text = ipcText(value);
    ipcDocument(id);
    const out = await renderBlocks(text, current.path);
    trace("render-done");
    return out;
  });
  handle("smd:render-fragment", (value, id) => {
    const text = ipcText(value);
    ipcDocument(id);
    return renderFragment(text, current.path ? path.dirname(current.path) : undefined);
  });
  handle("smd:save", (value, forceDialog, id) => {
    const text = ipcText(value);
    if (typeof forceDialog !== "boolean") throw new TypeError("Expected save option.");
    if (id !== current.documentId) return null;
    const documentId = ipcDocument(id);
    return documents.run(() => saveText(text, forceDialog, documentId));
  });
  handle("smd:accept-disk", (value, id) => {
    const text = ipcText(value);
    if (id !== current.documentId) return false;
    const documentId = ipcDocument(id);
    return documents.run(async () => {
      if (documentId !== current.documentId || !current.path || (await readDiskText(current.path)) !== text) return false;
      current.diskText = text;
      current.conflict = false;
      return true;
    });
  });
  handle("smd:save-image", (bytes, ext, id) => {
    const documentId = ipcDocument(id);
    if (!(bytes instanceof Uint8Array) || typeof ext !== "string") throw new TypeError("Invalid image.");
    return documents.run(() => documentId === current.documentId && current.path ? saveImageNextTo(current.path, bytes, ext) : Promise.resolve(null));
  });
  handle("smd:open-dialog", openDialog);
  handle("smd:open-path", (p, intent) => openFile(ipcText(p), ipcIntent(intent)));
  handle("smd:open-link", (href, intent) => openLink(ipcText(href), ipcIntent(intent)));
  handle("smd:set-settings", applySettings);
  handle("smd:export-pdf", (value, id) => {
    const text = ipcText(value);
    const documentId = ipcDocument(id);
    return documents.run(() => { ipcDocument(documentId); return exportPdf(text); });
  });
  handle("smd:export-html", (value, id) => {
    const text = ipcText(value);
    const documentId = ipcDocument(id);
    return documents.run(() => { ipcDocument(documentId); return exportHtml(text); });
  });
  handle("smd:print", (value, id) => {
    const text = ipcText(value);
    const documentId = ipcDocument(id);
    return documents.run(() => { ipcDocument(documentId); return printDoc(text); });
  });
  ipcMain.on("smd:print-ready", (e, error: unknown) => {
    if (e.senderFrame === e.sender.mainFrame) printWaiters.get(e.sender.id)?.(typeof error === "string" ? error : undefined);
  });
  ipcMain.on("smd:hide", (e) => { if (mainSender(e)) void hideWindow(); });
  ipcMain.on("smd:command", (e, cmd: unknown) => {
    if (!mainSender(e) || typeof cmd !== "string") return;
    const commands: readonly string[] = ["preferences", "new", "save", "save-as", "toggle-edit", "mode-live", "mode-split", "mode-source", "undo", "redo", "find", "palette", "outline", "zoom-in", "zoom-out", "zoom-reset", "export-pdf", "export-html", "print", "nav-back", "nav-forward", "toggle-task", "reveal", "format-bold", "format-italic", "format-link", "format-code", "format-strike"];
    if (commands.includes(cmd)) runCommand(cmd as Command);
  });
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

function fileArg(argv: string[]): string | undefined {
  return argv.slice(1).find((a) => !a.startsWith("-") && isMarkdown(a) && fs.existsSync(a));
}

async function prepareQuit(): Promise<void> {
  trace("quit-cleanup-start");
  quitting = true;
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = undefined;
  watcher?.close();
  helper?.stop();
  flushSettings();
  trace("quit-resources-closed");
  await disposeRenderer();
  trace("quit-worker-stopped");
  if (win && !win.isDestroyed()) win.destroy();
  trace("quit-window-destroyed");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let pendingOpen = fileArg(process.argv);

  app.setAboutPanelOptions({ applicationName: "SimpleMD", copyright: "© Jonathan Ray Reed. MIT License." });

  app.on("second-instance", (_e, argv) => void openFile(fileArg(argv), "edit"));
  app.on("open-file", (e, file) => {
    e.preventDefault();
    if (win) void openFile(file, "edit");
    else pendingOpen = file;
  });
  let quitRequest: Promise<boolean> | undefined;
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    if (quitRequest) return;
    quitRequest = documents.run(() => quitAfterSettle({
      settle: () => transition(settle),
      cleanup: prepareQuit,
      exit: () => app.exit(0),
    })).finally(() => { quitRequest = undefined; });
    void quitRequest.catch((err) => console.error("simple-md: could not quit", err));
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    helper?.stop();
    watcher?.close();
    flushSettings();
    disposeRenderer();
  });
  app.on("activate", () => {
    if (win) reveal();
  });
  app.on("window-all-closed", () => {});

  void app.whenReady().then(async () => {
    trace("app-ready");
    nativeTheme.themeSource = settings.theme;
    session.defaultSession.setSpellCheckerEnabled(settings.spellcheck);
    hardenSession();
    registerIpc();
    win = createWindow();
    trace("window-created");
    // A login launch stays invisible until the first peek; a real launch shows its skeleton
    // immediately (backgroundColor, not a white flash) and the first document swaps in over it.
    const backgroundLaunch =
      process.argv.includes("--background") ||
      (process.platform === "darwin" && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin);
    if (backgroundLaunch && !pendingOpen && process.platform === "darwin") app.dock?.hide();
    if (!backgroundLaunch || pendingOpen) reveal(pendingOpen && process.env.SMD_INTENT === "peek" ? "peek" : "edit");
    win.webContents.once("did-finish-load", () => trace("page-loaded"));
    createTray();
    refreshMenus();
    registerShortcut();
    syncPeekHelper();
    void warmUp().catch((err) => console.error("simple-md: renderer warmup failed", err));
    if (pendingOpen) await openFile(pendingOpen, process.env.SMD_INTENT === "peek" ? "peek" : "edit");
    const drive = process.env.SMD_DRIVE;
    if (drive && !app.isPackaged) {
      try {
        await rendererLoaded;
        const outcome = await runDriver(win, drive, async (target) => {
          const flushed = await requestFlush();
          if (!flushed) throw new Error("The renderer did not provide export text.");
          await fs.promises.writeFile(target, await makePdf(flushed.text));
        }, async (target) => {
          const flushed = await requestFlush();
          if (!flushed) throw new Error("The renderer did not provide export text.");
          await fs.promises.writeFile(target, await makeHtml(flushed.text));
        }, () => app.quit());
        if (outcome === "menu-quit") return;
        await prepareQuit();
        app.exit(0);
      } catch (err) {
        console.error("simple-md: driver failed", err);
        await prepareQuit();
        app.exit(1);
      }
    }
  });
}

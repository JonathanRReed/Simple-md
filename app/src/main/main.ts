import { DragExports, type ExportFormat } from "./drag-export.js";
import { readGitBaseline } from "./git-baseline.js";
import { startOptionalCliServer, type CliDispatch } from "./cli-server.js";
import { DocumentWaiters, parseOpenUrl } from "./cli-protocol.js";
import { installCli, bundledCli } from "./install-cli.js";
import { FlushWaiters } from "./flush-waiters.js";
import { menuState } from "./menu-state.js";
import { watchWindowTheme } from "./window-theme.js";
import { readFindText, writeFindText } from "./find-pasteboard.js";
import { recentFiles, isolatedRecents, jumpList, clearNativeRecents } from "./recents.js";
import { shareDocument } from "./share.js";
import { contextTemplate, validateContext } from "./context-menu.js";
import type { ContextResult, NativeContext } from "../shared/native-context.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { TabLayout } from "../shared/tab-layout.js";
import { documentDelta, releaseDocumentDelta } from "./document-delta.js";
import { resolveAuthorUrl } from "../shared/url-resolver.js";
import { containedLocalFile, invalidateUrlContext, urlContext } from "./document-urls.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BrowserWindow,
  clipboard,
  Menu,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  systemPreferences,
} from "electron";
import { isDocumentId, isPaneId, isRevisionId, isRequestId, makePaneId, makeRequestId, type DocumentId, type RequestId, type RevisionId } from "../shared/types.js";
import { DocumentRegistry } from "./document-registry.js";
import { DocumentSession } from "./document-session.js";
import type {
  Command,
  DocPayload,
  FlushResult,
  OpenIntent,
  Settings,
  SaveResult,
} from "../shared/types.js";
import { ENCODING_NOTICE, isMarkdown, readDocument, saveImageNextTo } from "./files.js";
import { DocumentQueue, openPreparedDocument, quitAfterSettle, settleDocument } from "./lifecycle.js";
import { createExportJobs, printWaiters, writeExportAtomic } from "./export-job.js";
import { runDriver } from "./driver.js";
import { perfMark } from "./perf.js";
import { blockChanges, startBlocks, nextBlocks, disposeRenderer, mdxRanges, renderBlocks, renderFragment } from "./render-client.js";
import { getCachedRender, setCachedRender } from "./render-cache.js";
import { buildMenu } from "./menu.js";
import { configEntries } from "../shared/config-schema.js";
import { createSettingsWindow, systemAccent } from "./settings-window.js";
import { configStore, flushSettings, loadSettings, patchSettings, saveSettings } from "./settings.js";

// Dev-only launch profiler: SMD_TRACE=1 prints where startup time goes.
const T0 = performance.now();
const tracing = !!process.env.SMD_TRACE;
const trace = (mark: string) => {
  if (tracing) console.error(`trace ${mark}: ${(performance.now() - T0).toFixed(0)}ms`);
};
trace("main-bundle-loaded");

app.setName("SimpleMD");
if (process.platform === "win32") app.setAppUserModelId("com.jonathanreed.simplemd");

const testProfile = !app.isPackaged && !!process.env.SMD_USER_DATA;
if (testProfile) app.setPath("userData", path.resolve(process.env.SMD_USER_DATA!));
else app.setPath("userData", path.join(app.getPath("appData"), app.name));

const recentOS = testProfile ? isolatedRecents() : app;
const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, "renderer", "index.html");

let settings: Settings = { ...loadSettings() };
let tray: Tray | undefined;
const cliWaiters = new DocumentWaiters();
let cliServer: Awaited<ReturnType<typeof startOptionalCliServer>> | undefined;
const registry = new DocumentRegistry(id => cliWaiters.closed(id));
const documents = new DocumentQueue();
interface WindowContext {
  win: BrowserWindow;
  layout: TabLayout;
  paneModes: Map<ReturnType<typeof makePaneId>, Settings["mode"]>;
  mainPane: { paneId: ReturnType<typeof makePaneId>; documentId: DocumentId };
  rendererReady: boolean;
  nativeContext?: NativeContext;
  loaded: Promise<void>;
  markLoaded(): void;
}
const windows = new Map<number, WindowContext>();
const windowScope = new AsyncLocalStorage<WindowContext>();
let frontmost: WindowContext;
function context(): WindowContext { return windowScope.getStore() ?? frontmost; }
const currentSession = (host = context()) => registry.get(host.mainPane.documentId)!;
function syncLayout(host = context()): void {
  const active = host.layout.active;
  if (active) Object.assign(host.mainPane, active);
  sendTo(host, "smd:layout", host.layout.state);
  if (active) updateTitle(host);
  refreshMenus();
}
function createDocumentWindow(): WindowContext {
  let markLoaded!: () => void;
  const loaded = new Promise<void>(resolve => { markLoaded = resolve; });
  const empty = registry.create(null, "");
  const host: WindowContext = {
    win: undefined!, layout: new TabLayout(), paneModes: new Map(),
    mainPane: { paneId: makePaneId(0), documentId: empty.documentId },
    rendererReady: false, loaded, markLoaded,
  };
  host.win = createWindow(host);
  windows.set(host.win.webContents.id, host);
  frontmost = host;
  return host;
}
let quitting = false;
let settingsWindow: ReturnType<typeof createSettingsWindow> | undefined;

function sendTo(host: WindowContext, channel: string, ...args: unknown[]): void {
  if (host.win && !host.win.isDestroyed()) host.win.webContents.send(channel, ...args);
}
const send = (channel: string, ...args: unknown[]) => sendTo(context(), channel, ...args);

// ───────── settings ─────────

function applySettings(patch: unknown, persist = true): void {
  const prev = settings;
  let next = patchSettings(settings, patch);
  if (persist) {
    const changed = Object.fromEntries(configEntries.filter(([, def]) => patch !== null && typeof patch === "object" && Object.hasOwn(patch, def.setting)).map(([, def]) => [def.setting, next[def.setting]]));
    if (Object.keys(changed).length) next = { ...next, ...configStore().set(changed) };
  }
  next.systemAccent = systemAccent();
  settings = next;
  nativeTheme.themeSource = settings.theme;
  if (settings.launchAtLogin !== prev.launchAtLogin) applyLoginItem();
  if (settings.spellcheck !== prev.spellcheck) session.defaultSession.setSpellCheckerEnabled(settings.spellcheck);
  saveSettings(settings);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("smd:settings", settings);
  }
  settingsWindow?.changed();
  refreshMenus();
}

let lastMenuState: ReturnType<typeof menuState> | undefined;
function refreshMenus(): void {
  const recents = recentFiles(recentOS, process.platform, settings.recents);
  if (JSON.stringify(recents) !== JSON.stringify(settings.recents)) {
    settings.recents = recents;
    saveSettings(settings);
  }
  const host = frontmost;
  const mode = host?.paneModes.get(host.mainPane.paneId) ?? settings.mode;
  const activeDoc = registry.get(host?.mainPane.documentId);
  const gitStatus = activeDoc?.gitStatus ?? { available: false as const, reason: "Open a file first." };
  const next = menuState(settings, mode, !!activeDoc?.path, gitStatus);
  if (next.application !== lastMenuState?.application) buildMenu({
    settings: () => ({ ...settings, mode }),
    changesStatus: () => gitStatus,
    command: (cmd) => runCommand(cmd),
    openDialog: () => void openDialog(),
    openPath: (p) => void openFile(p, "edit"),
    patch: applySettings,
    clearRecents: () => {
      clearNativeRecents(recentOS, process.platform);
      applySettings({ recents: [] });
    },
    share: () => { const doc = currentSession(); if (doc?.path) shareDocument(context().win, doc.path); },
    canShare: () => !!currentSession()?.path,
    installCli: () => void installCli(),
    quit: () => app.quit(),
  });
  if (next.tray !== lastMenuState?.tray) tray?.setContextMenu(trayMenu());
  if (next.recents !== lastMenuState?.recents && process.platform === "win32") recentOS.setJumpList(jumpList(process.execPath, app.isPackaged ? undefined : app.getAppPath(), settings.recents));
  if (next.recents !== lastMenuState?.recents && process.platform === "darwin") app.dock?.setMenu(Menu.buildFromTemplate([
    { label: "New Window", click: () => void newDocumentWindow() },
    ...settings.recents.map(file => ({ label: path.basename(file), click: () => void openFile(file, "edit") })),
  ]));
  lastMenuState = next;
}

function addRecent(file: string): void {
  if (process.platform !== "linux") recentOS.addRecentDocument(file);
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

function createWindow(host: WindowContext): BrowserWindow {
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
      // Tray opens must not wait for a throttled renderer round trip.
      backgroundThrottling: false,
    },
  });
  if (!mac) {
    watchWindowTheme(nativeTheme, w, overlayColors);
  }
  if (!settings.bounds) w.center();
  void w.loadFile(INDEX);

  w.webContents.on("context-menu", (_event, params) => {
    const host = windows.get(w.webContents.id);
    if (!host) return;
    host.nativeContext = {
      selectionPresent: params.selectionText.length > 0, editable: params.isEditable,
      linkURL: params.linkURL.startsWith(w.webContents.getURL().split("#")[0] + "#") ? new URL(params.linkURL).hash : params.linkURL, imageURL: params.srcURL,
      misspelledWord: params.misspelledWord, suggestions: params.dictionarySuggestions.slice(0, 32),
    };
    w.webContents.send("smd:context-request", host.nativeContext);
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    void openLink(url, "edit", false, currentSession(host), host);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    void openLink(url, "edit", false, currentSession(host), host);
  });

  let boundsTimer: NodeJS.Timeout | undefined;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (w.isDestroyed() || w.isMaximized() || w.isFullScreen() || w.isMinimized()) return;
      applySettings({ bounds: w.getBounds() });
    }, 400);
  };
  w.on("focus", () => { frontmost = windows.get(w.webContents.id) ?? frontmost; trace("win-focus"); if (!quitting) refreshMenus(); });
  w.on("blur", () => trace("win-blur"));
  w.on("hide", () => trace("win-hide"));
  w.on("show", () => trace("win-show"));
  w.on("resize", rememberBounds);
  w.on("move", rememberBounds);

  // Keep the normal document window resident for tray opens after closing it.
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    void documents.run(() => closeDocumentWindow(host));
  });
  const webContentsId = w.webContents.id;
  w.on("closed", () => {
    windows.delete(webContentsId);
    if (frontmost?.win === w) frontmost = [...windows.values()].find(host => !host.win.isDestroyed() && host.win.isVisible()) ?? [...windows.values()].at(-1) ?? frontmost;
  });
  return w;
}

function hideWindow(): Promise<void> {
  return documents.run(() => transition(hideCurrentWindow));
}

async function hideCurrentWindow(): Promise<void> {
  trace("hide-requested");
  if (await settle()) {
    context().win.hide();
    if (process.platform === "darwin") app.dock?.hide();
    trace("hide-done");
  } else {
    trace("hide-cancelled");
  }
}

async function closeTab(id = currentSession().documentId, host = context()): Promise<boolean> {
  const doc = registry.get(id);
  if (!doc || !(await transition(() => settle(doc, host), host))) return false;
  host.layout.remove(id);
  registry.remove(id);
  releaseDocumentDelta(id);
  sendTo(host, "smd:closed", id);
  syncLayout(host);
  if (!host.layout.state.tabs.length) {
    finishClosedWindow(host);
  }
  return true;
}
async function closeDocumentWindow(host = context()): Promise<void> {
  for (const id of [...host.layout.state.tabs]) if (!(await closeTab(id, host))) return;
  if (!host.layout.state.tabs.length) finishClosedWindow(host);
}
function finishClosedWindow(host: WindowContext): void {
  if (host.win.isDestroyed()) return;
  if (windows.size > 1) { host.win.destroy(); return; }
  host.paneModes.clear();
  host.win.setTitle("SimpleMD");
  if (process.platform === "darwin") {
    host.win.setDocumentEdited(false);
    host.win.setRepresentedFilename("");
  }
  host.win.hide();
  if (process.platform === "darwin") app.dock?.hide();
}

// ───────── renderer round trips ─────────

const flushWaiters = new FlushWaiters();
let flushSeq = 0;

function requestFlush(doc = currentSession(), host = context()): Promise<FlushResult | null> {
  return new Promise((resolve) => {
    if (!doc || !host.rendererReady || host.win.isDestroyed()) return resolve(null);
    const id = makeRequestId(++flushSeq);
    const windowId = host.win.webContents.id;
    const timer = setTimeout(() => {
      flushWaiters.delete(windowId, id);
      resolve(null);
    }, 1500);
    flushWaiters.set(windowId, id, (r) => {
      clearTimeout(timer);
      flushWaiters.delete(windowId, id);
      if (r?.documentId !== doc.documentId || !doc.isCurrent(r.revisionId) || !doc.edit(r.text, r.revisionId)) return resolve(null);
      if (r.conflict) doc.conflict = true;
      resolve(r);
    });
    sendTo(host, "smd:flush-request", id, doc.documentId);
  });
}

/** Saves or discards pending edits before the window changes document or hides. False means the user cancelled. */
async function transition<T>(operation: () => Promise<T>, host = context()): Promise<T> {
  sendTo(host, "smd:transition", true);
  try {
    return await operation();
  } finally {
    sendTo(host, "smd:transition", false);
  }
}

async function settle(current = currentSession(), host = context()): Promise<boolean> {
  await host.loaded;
  if (!current) return true;
  let discarded = false;
  const settled = await settleDocument({
    documentId: current.documentId,
    autosave: settings.autosave,
    hasPath: current.path !== null,
    flush: () => requestFlush(current, host),
    save: async (text) => (await saveText(text, false, current.documentId, host)) !== null,
    choose: async () => {
      reveal(host);
      const { response } = await dialog.showMessageBox(host.win, {
        type: "warning",
        message: `Save changes to “${current.name}”?`,
        detail: "Your changes will be lost if you don't save them.",
        buttons: ["Save", "Don't Save", "Cancel"],
        defaultId: 0,
        cancelId: 2,
      });
      discarded = response === 1;
      return response === 0 ? "save" : response === 1 ? "discard" : "cancel";
    },
  });
  if (settled && discarded) cliWaiters.closed(current.documentId);
  return settled;
}

// ───────── documents ─────────

const baseUrlOf = (file: string | null) =>
  file ? pathToFileURL(path.dirname(file)).href.replace(/\/?$/, "/") : null;

async function payloadFor(doc: DocumentSession, fromDisk = false, text = doc.text, intent = doc.intent, host = context()): Promise<DocPayload> {
  const file = doc.path;
  const readOnlyReason = doc.readOnlyReason;
  let stream: number | undefined;
  let title: string;
  let blocks: DocPayload["blocks"];
  let mdx: DocPayload["mdx"];
  const isMdx = path.extname(file ?? doc.name).toLowerCase() === ".mdx";
  if (!readOnlyReason && intent === "edit" && settings.mode !== "split") {
    title = doc.name;
    blocks = [];
    if (isMdx) mdx = await mdxRanges(text);
  } else if (file && fromDisk && path.extname(file).toLowerCase() !== ".mdx") {
    const stat = await fs.promises.stat(file).catch(() => null);
    perfMark("read-and-hash-start", { path: file });
    const hit = stat && getCachedRender(file, stat.mtimeMs, stat.size, text);
    perfMark("read-and-hash-end", { path: file, diskRenderCache: hit ? "hit" : "miss" });
    if (hit) {
      ({ title, blocks } = hit);
    } else {
      ({ title, blocks, mdx, stream } = await (intent === "read" && fromDisk ? startBlocks(text, file) : renderBlocks(text, file ?? doc.name)));
      if (stat && stream === undefined) setCachedRender(file, stat.mtimeMs, stat.size, title, blocks, text);
    }
  } else {
    ({ title, blocks, mdx, stream } = await (intent === "read" && fromDisk ? startBlocks(text, file) : renderBlocks(text, file ?? doc.name)));
  }
  return {
    documentId: doc.documentId,
    savedText: doc.dirty ? doc.diskText ?? "" : undefined,
    dirty: doc.dirty,
    revisionId: doc.revisionId,
    paneId: host.mainPane.paneId,
    stream,
    path: file,
    name: doc.name,
    text,
    blocks,
    mdx,
    title,
    intent,
    baseUrl: doc.baseUrl,
    readOnlyReason,
  };
}

function updateTitle(host = context()): void {
  const current = currentSession(host);
  if (host.win.isDestroyed()) return;
  host.win.setTitle(process.platform === "darwin" ? current.name : `${current.name}${current.dirty ? " (Edited)" : ""} | SimpleMD`);
  if (process.platform === "darwin") {
    host.win.setDocumentEdited(current.dirty);
    host.win.setRepresentedFilename(current.path ?? "");
  }
}

function watch(doc: DocumentSession, host = context()): void {
  doc.watch((text, reason) => sendTo(host, "smd:disk-changed", text, doc.documentId, reason));
}

const documentWaiters = new Map<string, Set<() => void>>();
function waitUntilUsable(id: DocumentId, host = context()): Promise<void> {
  const key = `${host.win.webContents.id}:${id}`;
  const waiters = documentWaiters.get(key) ?? new Set<() => void>();
  documentWaiters.set(key, waiters);
  return new Promise<void>((resolve, reject) => {
    const remove = () => { waiters.delete(done); if (!waiters.size) documentWaiters.delete(key); };
    const timer = setTimeout(() => { remove(); reject(new Error("The document did not finish loading.")); }, 15_000);
    const done = () => {
      clearTimeout(timer); remove();
      trace(`document-usable id=${id} name=${registry.get(id)?.name}`);
      resolve();
    };
    waiters.add(done);
  });
}
async function present(payload: DocPayload, host = context()): Promise<void> {
  await host.loaded;
  const previous = host.mainPane.documentId;
  host.layout.add(payload.documentId);
  Object.assign(host.mainPane, host.layout.active);
  payload.paneId = host.mainPane.paneId;
  if (!host.layout.has(previous)) registry.remove(previous);
  const doc = currentSession(host);
  watch(doc, host);
  updateTitle(host);
  const usable = waitUntilUsable(payload.documentId, host);
  perfMark("renderer-send", { path: payload.path, documentId: payload.documentId });
  sendTo(host, "smd:doc", payload);
  syncLayout(host);
  trace(`doc-sent name=${payload.name} blocks=${payload.blocks.length} intent=${payload.intent}`);
  await usable;
}

function reveal(host = context()): void {
  if (!host || host.win.isDestroyed()) host = createDocumentWindow();
  if (process.platform === "darwin") void app.dock?.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  if (!host.win.isVisible()) host.win.show();
  host.win.focus();
}

function openFile(file: string | undefined, intent: OpenIntent, inPlace = false, documentId?: DocumentId, origin = context()): Promise<boolean> {
  if (!context() || context().win.isDestroyed()) createDocumentWindow();
  const host = inPlace ? origin : frontmost;
  return windowScope.run(host, () => documents.run(() => openCurrentFile(file, intent, inPlace, documentId, host)));
}

async function openCurrentFile(file: string | undefined, intent: OpenIntent, inPlace = false, documentId?: DocumentId, host = context(), cli = false): Promise<boolean> {
  if (!file) {
    reveal(host);
    return true;
  }
  if (!cli && !isMarkdown(file)) return false;
  const abs = path.resolve(file);
  const canonical = await fs.promises.realpath(abs).catch(() => abs);
  for (const host of windows.values()) {
    let existing: DocumentId | undefined;
    for (const id of host.layout.state.tabs) {
      const file = registry.get(id)?.path;
      if (file && (file === abs || await fs.promises.realpath(file).catch(() => file) === canonical)) { existing = id; break; }
    }
    if (existing !== undefined) return windowScope.run(host, async () => {
      const usable = waitUntilUsable(existing, host);
      perfMark("file-open-arrival", { path: abs });
      host.layout.activate(existing);
      syncLayout(host); reveal(host);
      await usable;
      return true;
    });
  }
  if (!inPlace && settings.openIn === "window" && host.layout.state.tabs.length) {
    const host = createDocumentWindow();
    return windowScope.run(host, () => openCurrentFile(abs, intent, false, undefined, host, cli));
  }
  const replaced = inPlace ? documentId ?? host.mainPane.documentId : undefined;
  perfMark("file-open-arrival", { path: abs });
  let prepared: DocumentSession | undefined;
  try {
    return await openPreparedDocument({
      prepare: async () => {
        invalidateUrlContext(path.dirname(abs));
        perfMark("read-start", { path: abs });
        const { text, readOnlyReason } = await readDocument(abs);
        if (cli && readOnlyReason === ENCODING_NOTICE) throw new Error(ENCODING_NOTICE);
        perfMark("read-end", { path: abs });
        prepared = registry.create(abs, text, intent, readOnlyReason);
        return payloadFor(prepared, true, prepared.text, intent, host);
      },
      transition: operation => transition(operation, host),
      settle: () => replaced !== undefined ? settle(registry.get(replaced), host) : Promise.resolve(true),
      refresh: async (payload) => {
        const latest = await readDocument(abs);
        if (cli && latest.readOnlyReason === ENCODING_NOTICE) throw new Error(ENCODING_NOTICE);
        if (latest.text === payload.text && latest.readOnlyReason === payload.readOnlyReason) return payload;
        if (prepared) registry.remove(prepared.documentId);
        prepared = registry.create(abs, latest.text, intent, latest.readOnlyReason);
        return payloadFor(prepared, true, prepared.text, intent, host);
      },
      present: async (payload) => {
        reveal(host);
        if (replaced !== undefined) {
          host.layout.replace(replaced, payload.documentId);
          registry.remove(replaced);
          sendTo(host, "smd:closed", replaced);
        }
        await present(payload, host);
        addRecent(abs);
      },
    });
  } catch (err) {
    console.error("simple-md: failed to open", abs, err);
    if (!cli) void dialog.showMessageBox(host.win, { type: "error", message: `Couldn’t open “${path.basename(abs)}”.`, detail: String(err) });
    return false;
  } finally {
    if (prepared && !host.layout.has(prepared.documentId)) registry.remove(prepared.documentId);
  }
}

function newDoc(): Promise<void> {
  return documents.run(() => transition(async () => {
    reveal();
    const doc = registry.create(null, "", "edit");
    try { await present(await payloadFor(doc)); }
    finally { if (!context().layout.has(doc.documentId)) registry.remove(doc.documentId); }
  }));
}

function openDialog(): Promise<boolean> {
  return documents.run(async () => {
    reveal();
    const res = await dialog.showOpenDialog(context().win, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mdx", "txt"] }],
    });
    if (res.canceled || !res.filePaths[0]) return false;
    let opened = true;
    for (const file of res.filePaths) opened = await openCurrentFile(file, "edit") && opened;
    return opened;
  });
}

async function saveText(text: string, forceDialog: boolean, documentId: DocumentId, host = context()): Promise<SaveResult | null> {
  const doc = registry.get(documentId);
  if (!doc || doc.text !== text || doc.readOnlyReason || (doc.conflict && !forceDialog)) return null;
  const revisionId = doc.revisionId;
  let target = doc.path;
  if (!target || forceDialog) {
    const res = await dialog.showSaveDialog(host.win, {
      defaultPath: doc.path ?? path.join(app.getPath("documents"), `${doc.name.replace(/\.[^.]+$/, "")}.md`),
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  const moved = target !== doc.path;
  try {
    const result = await doc.save(target, revisionId, forceDialog);
    if (!result) return null;
    if (moved) addRecent(target);
    updateTitle(host);
    sendTo(host, "smd:saved", result);
    return result;
  } catch (err) {
    void dialog.showMessageBox(host.win, { type: "error", message: `Couldn’t save “${path.basename(target)}”.`, detail: String(err) });
    return null;
  }
}

// ───────── links & commands ─────────

async function openLink(href: string, intent: OpenIntent = "edit", newTab = false, current = currentSession(), host = context()): Promise<boolean> {
  if (/^(https?:|mailto:)/i.test(href)) {
    await shell.openExternal(href);
    return false;
  }
  if (!current.path) return false;
  const resolved = href.startsWith("file:") ? href : resolveAuthorUrl(href, "anchor", urlContext(path.dirname(current.path)));
  if (!resolved || !resolved.startsWith("file:")) return false;
  try {
    const canonical = await containedLocalFile(resolved, urlContext(path.dirname(current.path)));
    const target = fileURLToPath(resolved);
    return isMarkdown(target) && isMarkdown(canonical) ? openFile(target, intent, !newTab, current.documentId, host) : false;
  } catch {
    return false;
  }
}

async function togglePanes(axis: "horizontal" | "vertical"): Promise<void> {
  const layout = context().layout;
  const active = layout.active;
  if (!active) return;
  if (layout.state.panes.length === 2) {
    layout.split(axis, layout.state.axis === axis ? active.documentId : layout.state.panes.find(p => p !== active)!.documentId);
  } else {
    let companion = layout.state.tabs.find(id => id !== active.documentId);
    if (companion === undefined) {
      const empty = registry.create(null, "", "edit");
      const payload = await payloadFor(empty);
      layout.state.tabs.push(empty.documentId);
      send("smd:doc", payload);
      companion = empty.documentId;
    }
    layout.split(axis, companion);
  }
  syncLayout();
}
async function moveTabToWindow(): Promise<void> {
  if (!context().layout.active) return;
  await transition(moveTabWindow);
}
async function moveTabWindow(): Promise<void> {
  const origin = context();
  const doc = currentSession();
  if (!(await requestFlush(doc))) return;
  const target = createDocumentWindow();
  await windowScope.run(target, async () => {
    await present(await payloadFor(doc));
    reveal();
  });
  origin.layout.remove(doc.documentId);
  windowScope.run(origin, () => { send("smd:closed", doc.documentId); syncLayout(); });
  if (!origin.layout.state.tabs.length) origin.win.destroy();
}
async function settleAllWindows(): Promise<boolean> {
  for (const host of windows.values()) {
    const accepted = await windowScope.run(host, async () => {
      for (const id of host.layout.state.tabs) if (!(await transition(() => settle(registry.get(id)!)))) return false;
      return true;
    });
    if (!accepted) return false;
  }
  return true;
}

async function newDocumentWindow(): Promise<void> {
  const host = createDocumentWindow();
  await windowScope.run(host, async () => { reveal(); await newDoc(); });
}

function runCommand(cmd: Command, target = context().layout.active?.documentId): void {
  const current = target === undefined ? undefined : registry.get(target);
  switch (cmd) {
    case "close-tab": {
      const host = context();
      if (host.layout.state.tabs.length && target !== undefined) void documents.run(() => closeTab(target, host));
      else finishClosedWindow(host);
      return;
    }
    case "mark-seen":
    case "toggle-head-changes":
    case "next-change":
    case "previous-change": send("smd:cmd", cmd, target); return;
    case "move-tab-window": void documents.run(moveTabToWindow); return;
    case "next-tab": context().layout.cycle(1); syncLayout(); return;
    case "previous-tab": context().layout.cycle(-1); syncLayout(); return;
    case "focus-pane": context().layout.focusOther(); syncLayout(); return;
    case "split-panes":
    case "stack-panes": void documents.run(() => togglePanes(cmd === "split-panes" ? "horizontal" : "vertical")); return;
    case "preferences":
      settingsWindow?.open();
      return;
    case "new":
      void newDoc();
      return;
    case "reveal":
      if (current?.path) shell.showItemInFolder(current.path);
      return;
    case "mode-live":
    case "mode-split":
    case "mode-source":
      reveal();
      send("smd:cmd", cmd, target);
      return;
    case "zoom-in":
    case "zoom-out":
    case "zoom-reset":
      applySettings({ zoom: cmd === "zoom-reset" ? 1 : settings.zoom + (cmd === "zoom-in" ? 0.1 : -0.1) });
      return;
    default:
      reveal();
      send("smd:cmd", cmd, target);
  }
}

// ───────── export & print ─────────

const exportJobs = createExportJobs(here, () => settings);
const exportSource = (text: string, current = currentSession()) => ({ path: current.path, name: current.name, text });
const makePdf = (text: string, current = currentSession()) => exportJobs.makePdf(exportSource(text, current));
const makeHtml = (text: string, current = currentSession()) => exportJobs.makeHtml(exportSource(text, current));
const withPrintWindow = <T>(text: string, use: (w: BrowserWindow, doc: DocPayload) => Promise<T>, current = currentSession()) =>
  exportJobs.withPrintWindow(exportSource(text, current), use);
const dragExports = new DragExports();

// M6a can unify this adapter with its shared export job without changing drag lifetime.
async function exportDocumentBytes(doc: DocumentSession, text: string, format: ExportFormat): Promise<Buffer> {
  return format === "pdf" ? makePdf(text, doc) : Buffer.from(await makeHtml(text, doc));
}

async function exportPdf(text: string): Promise<void> {
  const current = currentSession();
  const res = await dialog.showSaveDialog(context().win, {
    defaultPath: path.join(current.path ? path.dirname(current.path) : app.getPath("documents"), `${current.name.replace(/\.[^.]+$/, "")}.pdf`),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (res.canceled || !res.filePath) return;
  await writeExportAtomic(res.filePath, await makePdf(text), true);
  shell.showItemInFolder(res.filePath);
}

async function exportHtml(text: string): Promise<void> {
  const current = currentSession();
  const res = await dialog.showSaveDialog(context().win, {
    defaultPath: path.join(current.path ? path.dirname(current.path) : app.getPath("documents"), `${current.name.replace(/\.[^.]+$/, "")}.html`),
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (res.canceled || !res.filePath) return;
  await writeExportAtomic(res.filePath, await makeHtml(text), true);
  shell.showItemInFolder(res.filePath);
}


async function printDoc(text: string): Promise<void> {
  await withPrintWindow(
    text,
    (pw) => new Promise<void>((resolve, reject) => pw.webContents.print({ printBackground: true }, (ok, reason) => ok ? resolve() : reject(new Error(reason || "Printing was cancelled.")))),
  );
}

// ───────── tray residency ─────────

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

function trayMenu(): Electron.Menu {
  const radio = <K extends keyof Settings>(label: string, key: K, value: Settings[K]) => ({
    label,
    type: "radio" as const,
    checked: settings[key] === value,
    click: () => applySettings({ [key]: value } as Partial<Settings>),
  });
  return Menu.buildFromTemplate([
    { label: "Settings…", click: () => runCommand("preferences") },
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
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: settings.launchAtLogin,
      click: (item) => applySettings({ launchAtLogin: item.checked }),
    },
    { label: "Quit SimpleMD", click: () => app.quit() },
  ]);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(here, "assets", "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("SimpleMD");
  tray.setContextMenu(trayMenu());
  tray.on("click", () => {
    if (!context().win.isDestroyed() && context().win.isVisible() && context().win.isFocused()) void hideWindow();
    else reveal();
  });
}

// ───────── ipc ─────────

function mainSender(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !quitting && !!context().win && !context().win.isDestroyed() && e.sender === context().win.webContents && e.senderFrame === context().win.webContents.mainFrame;
}

function ipcText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected text.");
  return value;
}

function ipcSession(value: unknown): DocumentSession {
  if (!isDocumentId(value) || !context().layout.has(value)) throw new Error("This document has been replaced.");
  const doc = registry.get(value);
  if (!doc) throw new Error("Unknown document.");
  return doc;
}

function ipcDocument(value: unknown): DocumentId { return ipcSession(value).documentId; }

function ipcRevision(doc: DocumentSession, value: unknown): RevisionId {
  if (!isRevisionId(value) || !doc.isCurrent(value)) throw new Error("Stale document revision.");
  return value;
}

function ipcIntent(value: unknown): OpenIntent {
  if (value === undefined || value === "edit") return "edit";
  if (value === "read") return "read";
  throw new TypeError("Unsupported open intent.");
}

function registerIpc(): void {
  const handle = (channel: string, use: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      const host = windows.get(e.sender.id);
      if (!host || e.senderFrame !== e.sender.mainFrame || quitting) throw new Error("Untrusted IPC sender.");
      return windowScope.run(host, () => use(...args));
    });
  };
  const on = (channel: string, use: (e: Electron.IpcMainEvent, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (e, ...args: unknown[]) => {
      const host = windows.get(e.sender.id);
      if (host && e.senderFrame === e.sender.mainFrame && !quitting) windowScope.run(host, () => use(e, ...args));
    });
  };
  handle("smd:activate-tab", id => { context().layout.activate(ipcDocument(id)); syncLayout(); });
  handle("smd:focus-pane", id => {
    if (!isPaneId(id)) throw new TypeError("Invalid pane.");
    context().layout.focus(id); syncLayout();
    return context().layout.active?.documentId;
  });
  handle("smd:close-tab", id => { const host = context(); const doc = ipcSession(id); return documents.run(() => closeTab(doc.documentId, host)); });
  handle("smd:ready", () => {
    trace("renderer-ready");
    context().rendererReady = true;
    context().markLoaded();
    return { settings, platform: process.platform, accent: systemAccent(), performanceTracing: testProfile && process.env.SMD_PERF === "1" };
  });
  on("smd:pane-mode", (_e, id, mode) => {
    if (!isPaneId(id) || !context().layout.state.panes.some(p => p.paneId === id) || (mode !== "live" && mode !== "source" && mode !== "split")) return;
    if (context().paneModes.get(id) === mode) return;
    context().paneModes.set(id, mode); refreshMenus();
  });
  on("smd:release-view", (_e, id) => { if (isDocumentId(id) && context().layout.has(id)) releaseDocumentDelta(id); });
  on("smd:editing", (e, id: unknown) => {
    if (!mainSender(e) || id !== currentSession().documentId) return;
    currentSession().intent = "edit";
    if (process.platform === "darwin") void app.dock?.show();
  });
  on("smd:perf-marker", (e, id: unknown, marker: unknown, rendererEpochMs: unknown) => {
    if (testProfile && mainSender(e) && id === currentSession().documentId && typeof marker === "string" &&
        ["renderer-receive", "renderer-mount", "first-readable", "fully-highlighted", "diagrams-ready", "ready-for-input"].includes(marker)) {
      perfMark(marker, { documentId: id, path: currentSession().path,
        rendererEpochMs: typeof rendererEpochMs === "number" && Number.isFinite(rendererEpochMs) ? rendererEpochMs : null,
        receiverEpochMs: performance.timeOrigin + performance.now(), windowVisible: context().win.isVisible() });
    }
  });
  on("smd:document-ready", (e, id: unknown) => {
    if (mainSender(e) && isDocumentId(id) && id === currentSession().documentId) documentWaiters.get(`${e.sender.id}:${id}`)?.forEach(done => done());
  });
  on("smd:flush-response", (e, id: unknown, r: unknown) => {
    if (!mainSender(e) || !isRequestId(id) || !r || typeof r !== "object") return;
    if (!("text" in r) || typeof r.text !== "string" || !("dirty" in r) || typeof r.dirty !== "boolean" ||
        !("documentId" in r) || !isDocumentId(r.documentId) || !("conflict" in r) || typeof r.conflict !== "boolean" || !("revisionId" in r) || !isRevisionId(r.revisionId)) return;
    flushWaiters.respond(e.sender.id, id, { text: r.text, dirty: r.dirty, documentId: r.documentId, revisionId: r.revisionId, conflict: r.conflict });
  });
  on("smd:dirty", (e, value: unknown, id: unknown) => {
    if (!mainSender(e) || !isDocumentId(id) || !context().layout.has(id) || typeof value !== "boolean") return;
    ipcSession(id).dirty = value;
    updateTitle();
  });
  on("smd:edit", (e, text: unknown, id: unknown, revision: unknown) => {
    if (!mainSender(e) || !isDocumentId(id) || !context().layout.has(id) || typeof text !== "string" || !isRevisionId(revision)) return;
    ipcSession(id).edit(text, revision);
  });
  handle("smd:next-blocks", (stream, id) => {
    ipcSession(id);
    if (typeof stream !== "number" || !Number.isSafeInteger(stream) || stream < 1) throw new TypeError("Expected render stream.");
    return nextBlocks(stream);
  });
  handle("smd:render-blocks", async (value, id, revision, known) => {
    const text = ipcText(value);
    const doc = ipcSession(id);
    const revisionId = ipcRevision(doc, revision);
    if (doc.text !== text) throw new Error("Render source does not match the document revision.");
    const out = await doc.render(revisionId, () => renderBlocks(text, doc.path ?? doc.name));
    trace("render-done");
    return documentDelta(doc.documentId, out, known !== true);
  });
  handle("smd:mdx-ranges", async (value, id, revision) => {
    const text = ipcText(value);
    const doc = ipcSession(id);
    const revisionId = ipcRevision(doc, revision);
    if (doc.text !== text) throw new Error("Render source does not match the document revision.");
    const out = await doc.render(revisionId, () => mdxRanges(text));
    trace("mdx-ranges-done");
    return out;
  });
  handle("smd:render-fragment", (value, id, revision) => {
    const text = ipcText(value);
    const doc = ipcSession(id);
    return doc.render(ipcRevision(doc, revision), () => renderFragment(text, doc.path ? path.dirname(doc.path) : undefined));
  });
  handle("smd:save", (value, forceDialog, id) => {
    const text = ipcText(value);
    if (typeof forceDialog !== "boolean") throw new TypeError("Expected save option.");
    const documentId = ipcDocument(id);
    return documents.run(() => saveText(text, forceDialog, documentId));
  });
  handle("smd:accept-disk", (value, id, automatic) => {
    const text = ipcText(value);
    const documentId = ipcDocument(id);
    return documents.run(() => ipcSession(documentId).acceptDisk(text, automatic === true));
  });
  handle("smd:changes", async (id, revision) => {
    const doc = ipcSession(id);
    const revisionId = ipcRevision(doc, revision);
    const baseline = doc.baseline;
    const generation = doc.baselineGeneration;
    const changes = baseline ? await doc.render(revisionId, () => blockChanges(baseline.text, doc.text, doc.path)) : { changed: [], deleted: [] };
    if (generation !== doc.baselineGeneration) throw new Error("The change baseline was replaced.");
    return { kind: baseline?.kind ?? null, generation, changes };
  });
  handle("smd:mark-seen", (id, revision, watchOnly) => {
    const doc = ipcSession(id);
    if (!isRevisionId(revision) || !doc.isCurrent(revision) || (watchOnly === true && doc.baseline?.kind !== "watch")) return false;
    doc.markSeen();
    if (doc.gitStatus.available) doc.gitStatus = { available: true, active: false };
    refreshMenus();
    return true;
  });
  handle("smd:git-status", id => ipcSession(id).gitStatus);
  handle("smd:head-changes", async (id, enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Expected change view option.");
    const doc = ipcSession(id);
    const generation = doc.baselineGeneration;
    const file = doc.path;
    if (enabled) {
      const result = await readGitBaseline(file);
      if (doc.path !== file || registry.get(doc.documentId) !== doc || generation !== doc.baselineGeneration) throw new Error("The document or change baseline was replaced.");
      doc.gitStatus = result.available ? { available: true, active: true } : result;
      if (result.available) doc.setHeadBaseline(result.text);
    } else {
      doc.markSeen();
      if (doc.gitStatus.available) doc.gitStatus = { available: true, active: false };
    }
    refreshMenus();
    return doc.gitStatus;
  });
  handle("smd:save-image", (bytes, ext, id) => {
    const documentId = ipcDocument(id);
    if (!(bytes instanceof Uint8Array) || typeof ext !== "string") throw new TypeError("Invalid image.");
    return documents.run(() => {
      const doc = ipcSession(documentId);
      return doc.path ? saveImageNextTo(doc.path, bytes, ext) : Promise.resolve(null);
    });
  });
  handle("smd:open-dialog", openDialog);
  handle("smd:open-path", (p, intent, id, inPlace) => { if (inPlace === true) ipcDocument(id); return openFile(ipcText(p), ipcIntent(intent), inPlace === true, inPlace === true ? ipcDocument(id) : undefined, context()); });
  handle("smd:open-link", (href, intent, id, newTab) => openLink(ipcText(href), ipcIntent(intent), newTab === true, ipcSession(id), context()));
  handle("smd:find-read", readFindText);
  handle("smd:find-write", text => writeFindText(ipcText(text)));
  handle("smd:context-menu", async (input, id) => {
    const host = context();
    const doc = ipcSession(id);
    const native = host.nativeContext;
    host.nativeContext = undefined;
    if (!native || JSON.stringify(input) !== JSON.stringify(native)) throw new Error("Stale context menu request.");
    const c = await validateContext(input, urlContext(doc.path ? path.dirname(doc.path) : undefined));
    if (!host.layout.has(doc.documentId) || host.win.isDestroyed()) return null;
    return new Promise<ContextResult>(resolve => {
      let result: ContextResult = null;
      const menu = Menu.buildFromTemplate(contextTemplate(c, {
        replace: word => { result = { kind: "spelling", replacement: word }; },
        dictionary: word => { host.win.webContents.session.addWordToSpellCheckerDictionary(word); },
        open: (url, newTab) => {
          if (url.startsWith("#")) result = { kind: "fragment", href: url };
          else void windowScope.run(host, () => openLink(url, doc.intent, newTab, doc, host));
        },
        copy: text => { void clipboard.writeText(text); },
        reveal: url => { void containedLocalFile(url, urlContext(doc.path ? path.dirname(doc.path) : undefined)).then(file => shell.showItemInFolder(file)).catch(() => {}); },
        lookup: () => host.win.webContents.showDefinitionForSelection(),
        share: doc.path ? () => shareDocument(host.win, doc.path!) : undefined,
      }));
      menu.popup({ window: host.win, callback: () => resolve(result) });
    });
  });
  handle("smd:set-settings", patch => applySettings(patch));
  handle("smd:prepare-drag-export", (value, id, revision, format) => {
    const text = ipcText(value);
    const doc = ipcSession(id);
    const revisionId = ipcRevision(doc, revision);
    if (text !== doc.text || (format !== "html" && format !== "pdf")) throw new TypeError("Invalid export source or format.");
    return documents.run(() => doc.render(revisionId, () => dragExports.prepare(doc.documentId, revisionId, doc.name, format, () => exportDocumentBytes(doc, text, format))));
  });
  on("smd:start-drag-export", (event, id, revision, token) => {
    try {
      const doc = ipcSession(id);
      const revisionId = ipcRevision(doc, revision);
      if (typeof token !== "string") throw new TypeError("Invalid export token.");
      const file = dragExports.take(token, doc.documentId, revisionId);
      void app.getFileIcon(file, { size: "small" }).then(icon => {
        if (event.sender.isDestroyed() || !doc.isCurrent(revisionId)) return;
        event.sender.startDrag({ file: dragExports.take(token, doc.documentId, revisionId), icon });
      }).catch(error => console.warn("simplemd: could not start export drag", error));
    } catch (error) { console.warn("simplemd: drag export unavailable", error); }
  });
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
  on("smd:hide", (e, id: unknown) => { if (mainSender(e) && id === context().mainPane.documentId) void hideWindow(); });
  on("smd:command", (e, cmd: unknown, id: unknown) => {
    if (!mainSender(e) || typeof cmd !== "string" || !isDocumentId(id) || (!context().layout.has(id) && context().layout.state.tabs.length)) return;
    const commands: readonly string[] = ["mark-seen", "toggle-head-changes", "next-change", "previous-change", "close-tab", "move-tab-window", "next-tab", "previous-tab", "split-panes", "stack-panes", "focus-pane", "preferences", "new", "save", "save-as", "toggle-edit", "mode-live", "mode-split", "mode-source", "undo", "redo", "find", "use-selection-find", "palette", "outline", "zoom-in", "zoom-out", "zoom-reset", "export-pdf", "export-html", "print", "nav-back", "nav-forward", "toggle-task", "reveal", "format-bold", "format-italic", "format-link", "format-code", "format-strike"];
    if (commands.includes(cmd)) runCommand(cmd as Command, id);
  });
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

const dispatchCli: CliDispatch = async (request, stdin, closed, signal) => {
  if (request.command === "export") {
    const { text, readOnlyReason } = await readDocument(request.path);
    if (readOnlyReason === ENCODING_NOTICE) throw new Error(ENCODING_NOTICE);
    const input = await fs.promises.realpath(request.path);
    const output = await fs.promises.realpath(request.output).catch(() => path.resolve(request.output));
    if (input === output) throw new Error("Export cannot replace its input.");
    const source = { path: request.path, name: path.basename(request.path), text };
    const data = request.format === "html" ? await exportJobs.makeHtml(source) : await exportJobs.makePdf(source);
    if (signal.aborted) throw new Error("CLI disconnected.");
    await writeExportAtomic(request.output, data, request.overwrite);
    return;
  }
  return documents.run(async () => {
    if (signal.aborted) throw new Error("CLI disconnected.");
    if (!context() || context().win.isDestroyed()) createDocumentWindow();
    let host = frontmost;
    let doc: DocumentSession | undefined;
    if (request.command === "stdin") {
      if (Buffer.byteLength(stdin) !== request.length || stdin.includes("\0")) throw new Error("Invalid stdin text.");
      if (settings.openIn === "window" && host.layout.state.tabs.length) host = createDocumentWindow();
      doc = registry.create(null, stdin, "edit"); doc.displayName = request.name; doc.dirty = stdin.length > 0;
      const payload = await payloadFor(doc, false, doc.text, "edit", host);
      reveal(host); await present(payload, host);
    } else {
      if (!(await openCurrentFile(request.path, "edit", false, undefined, host, true))) throw new Error("The file could not be opened.");
      const canonical = await fs.promises.realpath(request.path);
      for (const candidate of windows.values()) {
        for (const id of candidate.layout.state.tabs) {
          const session = registry.get(id);
          if (session?.path && await fs.promises.realpath(session.path).catch(() => null) === canonical) { host = candidate; doc = session; break; }
        }
        if (doc) break;
      }
      if (!doc) throw new Error("The document closed before acceptance.");
      sendTo(host, "smd:navigate", doc.documentId, request.location);
    }
    if (request.wait && !signal.aborted) return cliWaiters.add(doc.documentId, closed);
  });
};
async function openUrl(value: string): Promise<void> {
  try {
    const target = parseOpenUrl(value);
    if (!isMarkdown(target.path)) throw new Error("Unsupported URL file.");
    const canonical = await fs.promises.realpath(target.path);
    if (!isMarkdown(canonical) || !(await fs.promises.stat(canonical)).isFile()) throw new Error("Unsupported URL file.");
    await dispatchCli({ id: "url", command: "open", path: target.path, location: target.location, wait: false }, "", () => {}, new AbortController().signal);
  } catch (error) { console.error("simplemd: rejected open URL", error instanceof Error ? error.message : String(error)); }
}

function fileArg(argv: string[]): string | undefined {
  return argv.slice(1).find((a) => !a.startsWith("-") && isMarkdown(a) && fs.existsSync(a));
}

async function prepareQuit(): Promise<void> {
  trace("quit-cleanup-start");
  quitting = true;
  tray?.destroy();
  tray = undefined;
  cliServer?.close();
  cliWaiters.clear();
  registry.dispose();
  configStore().close();
  settingsWindow?.close();
  flushSettings();
  trace("quit-resources-closed");
  await dragExports.dispose();
  await disposeRenderer();
  trace("quit-worker-stopped");
  for (const host of windows.values()) if (!host.win.isDestroyed()) host.win.destroy();
  trace("quit-window-destroyed");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let pendingOpen = fileArg(process.argv);
  let pendingUrl = process.argv.find(arg => arg.startsWith("simplemd:"));
  let cliReady = false;
  app.on("open-url", (event, value) => { event.preventDefault(); if (cliReady) void openUrl(value); else pendingUrl = value; });

  app.setAboutPanelOptions({ applicationName: "SimpleMD", copyright: "© Jonathan Ray Reed. MIT License." });

  app.on("second-instance", (_e, argv) => {
    const url = argv.find(arg => arg.startsWith("simplemd:"));
    if (url) { if (cliReady) void openUrl(url); else pendingUrl = url; }
    else if (argv.includes("--new-window")) void newDocumentWindow();
    else void openFile(fileArg(argv), "edit");
  });
  app.on("open-file", (e, file) => {
    e.preventDefault();
    if (context()) void openFile(file, "edit");
    else pendingOpen = file;
  });
  let quitRequest: Promise<boolean> | undefined;
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    if (quitRequest) return;
    quitRequest = documents.run(() => quitAfterSettle({
      settle: settleAllWindows,
      cleanup: prepareQuit,
      exit: () => app.exit(0),
    })).finally(() => { quitRequest = undefined; });
    void quitRequest.catch((err) => console.error("simple-md: could not quit", err));
  });
  app.on("will-quit", () => {
    cliServer?.close();
    registry.dispose();
    flushSettings();
    disposeRenderer();
  });
  app.on("activate", () => {
    if (!quitting) reveal();
  });
  app.on("window-all-closed", () => {});

  void app.whenReady().then(async () => {
    trace("app-ready");
    nativeTheme.themeSource = settings.theme;
    session.defaultSession.setSpellCheckerEnabled(settings.spellcheck);
    hardenSession();
    registerIpc();
    settings.systemAccent = systemAccent();
    settingsWindow = createSettingsWindow({ here, config: configStore(), apply: applySettings });
    configStore().watch(value => applySettings(value, false));
    nativeTheme.on("updated", () => applySettings({}, false));
    if (process.platform === "darwin") {
      const accentSubscription = systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", () => { if (!quitting) applySettings({}, false); });
      app.once("will-quit", () => systemPreferences.unsubscribeNotification(accentSubscription));
    } else if (process.platform === "win32") systemPreferences.on("accent-color-changed", () => { if (!quitting) applySettings({}, false); });
    createDocumentWindow();
    trace("window-created");
    // A login launch stays invisible until the first file open; a real launch shows its skeleton
    // immediately (backgroundColor, not a white flash) and the first document swaps in over it.
    const backgroundLaunch =
      process.argv.includes("--background") ||
      (process.platform === "darwin" && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin);
    if (backgroundLaunch && !pendingOpen && process.platform === "darwin") app.dock?.hide();
    if (!backgroundLaunch || pendingOpen) reveal();
    context().win.webContents.once("did-finish-load", () => trace("page-loaded"));
    createTray();
    refreshMenus();
    if (pendingOpen) await openFile(pendingOpen, process.env.SMD_INTENT === "read" ? "read" : "edit");
    cliReady = true;
    if (pendingUrl) await openUrl(pendingUrl);
    cliServer = await startOptionalCliServer({ binary: bundledCli(), profile: testProfile ? app.getPath("userData") : undefined, dispatch: dispatchCli });
    trace(cliServer ? "cli-ready" : "cli-unavailable");
    const drive = process.env.SMD_DRIVE;
    if (drive && !app.isPackaged) {
      try {
        await context().loaded;
        const outcome = await runDriver(context().win, drive, async (target) => {
          const flushed = await requestFlush();
          if (!flushed) throw new Error("The renderer did not provide export text.");
          await fs.promises.writeFile(target, await makePdf(flushed.text));
        }, async (target) => {
          const flushed = await requestFlush();
          if (!flushed) throw new Error("The renderer did not provide export text.");
          await fs.promises.writeFile(target, await makeHtml(flushed.text));
        }, () => app.quit(), async () => {
          const flushed = await requestFlush();
          if (!flushed || !(await documents.run(() => saveText(flushed.text, false, flushed.documentId)))) {
            throw new Error("The document could not be saved.");
          }
        });
        if (outcome === "menu-quit") return;
        await prepareQuit();
        app.exit(0);
      } catch (err) {
        console.error("simple-md: driver failed", err);
        await prepareQuit();
        app.exit(1);
      }
    }
  }).catch(error => { console.error("simplemd: startup failed", error); cliServer?.close(); app.exit(1); });
}

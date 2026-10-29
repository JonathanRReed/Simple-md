import { shareDocument } from "./share.js";
import { contextTemplate, validateContext } from "./context-menu.js";
import type { NativeContext } from "../shared/native-context.js";
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
import { isMarkdown, readDocument, saveImageNextTo } from "./files.js";
import { DocumentQueue, openPreparedDocument, quitAfterSettle, settleDocument } from "./lifecycle.js";
import { embedKatexFonts, embedLocalImages, EXPORT_LIGHT_THEME } from "./export-html.js";
import { runDriver } from "./driver.js";
import { perfMark } from "./perf.js";
import { startBlocks, nextBlocks, disposeRenderer, mdxRanges, renderBlocks, renderFragment } from "./render-client.js";
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

const testProfile = !app.isPackaged && !!process.env.SMD_USER_DATA;
if (testProfile) app.setPath("userData", path.resolve(process.env.SMD_USER_DATA!));
else app.setPath("userData", path.join(app.getPath("appData"), app.name));

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, "renderer", "index.html");

let settings: Settings = { ...loadSettings() };
let tray: Tray | undefined;
const registry = new DocumentRegistry();
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
const currentSession = () => registry.get(context().mainPane.documentId)!;
function syncLayout(): void {
  const active = context().layout.active;
  if (active) Object.assign(context().mainPane, active);
  send("smd:layout", context().layout.state);
  if (active) updateTitle();
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
  windowScope.run(host, () => { host.win = createWindow(); });
  windows.set(host.win.webContents.id, host);
  frontmost = host;
  return host;
}
let quitting = false;
let settingsWindow: ReturnType<typeof createSettingsWindow> | undefined;

const send = (channel: string, ...args: unknown[]) => {
  if (context().win && !context().win.isDestroyed()) context().win.webContents.send(channel, ...args);
};

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

function refreshMenus(): void {
  buildMenu({
    settings: () => ({ ...settings, mode: context().paneModes.get(context().mainPane.paneId) ?? settings.mode }),
    command: (cmd) => runCommand(cmd),
    openDialog: () => void openDialog(),
    openPath: (p) => void openFile(p, "edit"),
    patch: applySettings,
    share: () => { const doc = currentSession(); if (doc.path) shareDocument(context().win, doc.path); },
    canShare: () => !!currentSession().path,
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
      // Tray opens must not wait for a throttled renderer round trip.
      backgroundThrottling: false,
    },
  });
  if (!mac) {
    nativeTheme.on("updated", () => {
      if (!w.isDestroyed()) w.setTitleBarOverlay(overlayColors());
    });
  }
  if (!settings.bounds) w.center();
  void w.loadFile(INDEX);

  w.webContents.on("context-menu", (_event, params) => {
    const host = windows.get(w.webContents.id);
    if (!host) return;
    host.nativeContext = {
      selectionPresent: params.selectionText.length > 0, editable: params.isEditable,
      linkURL: params.linkURL, imageURL: params.srcURL,
      misspelledWord: params.misspelledWord, suggestions: params.dictionarySuggestions.slice(0, 32),
    };
    w.webContents.send("smd:context-request", host.nativeContext);
  });
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
  w.on("focus", () => { frontmost = windows.get(w.webContents.id) ?? frontmost; trace("win-focus"); });
  w.on("blur", () => trace("win-blur"));
  w.on("hide", () => trace("win-hide"));
  w.on("show", () => trace("win-show"));
  w.on("resize", rememberBounds);
  w.on("move", rememberBounds);

  // Keep the normal document window resident for tray opens after closing it.
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    void windowScope.run(windows.get(w.webContents.id)!, () => documents.run(() => closeDocumentWindow()));
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

async function closeTab(id = currentSession().documentId): Promise<boolean> {
  const doc = registry.get(id);
  if (!doc || !(await transition(() => settle(doc, true)))) return false;
  context().layout.remove(id);
  registry.remove(id);
  releaseDocumentDelta(id);
  send("smd:closed", id);
  syncLayout();
  if (!context().layout.state.tabs.length) {
    context().win.destroy();
    if (process.platform === "darwin" && !windows.size) app.dock?.hide();
  }
  return true;
}
async function closeDocumentWindow(): Promise<void> {
  for (const id of [...context().layout.state.tabs]) if (!(await closeTab(id))) return;
  if (!context().win.isDestroyed()) context().win.destroy();
}

// ───────── renderer round trips ─────────

const flushWaiters = new Map<RequestId, (r: FlushResult | null) => void>();
let flushSeq = 0;

function requestFlush(doc = currentSession()): Promise<FlushResult | null> {
  return new Promise((resolve) => {
    if (!doc || !context().rendererReady || context().win.isDestroyed()) return resolve(null);
    const id = makeRequestId(++flushSeq);
    const timer = setTimeout(() => {
      flushWaiters.delete(id);
      resolve(null);
    }, 1500);
    flushWaiters.set(id, (r) => {
      clearTimeout(timer);
      flushWaiters.delete(id);
      if (r?.documentId !== doc.documentId || !doc.isCurrent(r.revisionId) || !doc.edit(r.text, r.revisionId)) return resolve(null);
      if (r.conflict) doc.conflict = true;
      resolve(r);
    });
    send("smd:flush-request", id, doc.documentId);
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

async function settle(current = currentSession(), prompt = false): Promise<boolean> {
  await context().loaded;
  if (!current) return true;
  return settleDocument({
    documentId: current.documentId,
    autosave: !prompt && settings.autosave,
    hasPath: current.path !== null,
    flush: () => requestFlush(current),
    save: async (text) => (await saveText(text, false, current.documentId)) !== null,
    choose: async () => {
      reveal();
      const { response } = await dialog.showMessageBox(context().win, {
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

async function payloadFor(doc: DocumentSession, fromDisk = false, text = doc.text, intent = doc.intent): Promise<DocPayload> {
  const file = doc.path;
  const readOnlyReason = doc.readOnlyReason;
  let stream: number | undefined;
  let title: string;
  let blocks: DocPayload["blocks"];
  let mdx: DocPayload["mdx"];
  const isMdx = path.extname(file ?? "").toLowerCase() === ".mdx";
  if (!readOnlyReason && intent === "edit" && settings.mode !== "split") {
    title = file ? path.basename(file) : "Untitled";
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
      ({ title, blocks, mdx, stream } = await (intent === "read" && fromDisk ? startBlocks(text, file) : renderBlocks(text, file)));
      if (stat && stream === undefined) setCachedRender(file, stat.mtimeMs, stat.size, title, blocks, text);
    }
  } else {
    ({ title, blocks, mdx, stream } = await (intent === "read" && fromDisk ? startBlocks(text, file) : renderBlocks(text, file)));
  }
  return {
    documentId: doc.documentId,
    savedText: doc.diskText ?? "",
    dirty: doc.dirty,
    revisionId: doc.revisionId,
    paneId: context().mainPane.paneId,
    stream,
    path: file,
    name: file ? path.basename(file) : "Untitled",
    text,
    blocks,
    mdx,
    title,
    intent,
    baseUrl: doc.baseUrl,
    readOnlyReason,
  };
}

function updateTitle(): void {
  const current = currentSession();
  if (context().win.isDestroyed()) return;
  context().win.setTitle(`${current.name}${current.dirty ? " (Edited)" : ""} | SimpleMD`);
  context().win.setDocumentEdited(current.dirty);
  if (current.path) context().win.setRepresentedFilename(current.path);
}

function watch(doc: DocumentSession): void {
  doc.watch((text, reason) => send("smd:disk-changed", text, doc.documentId, reason));
}

const documentWaiters = new Map<string, Set<() => void>>();
function waitUntilUsable(id: DocumentId): Promise<void> {
  const key = `${context().win.webContents.id}:${id}`;
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
async function present(payload: DocPayload): Promise<void> {
  await context().loaded;
  const previous = context().mainPane.documentId;
  context().layout.add(payload.documentId);
  Object.assign(context().mainPane, context().layout.active);
  payload.paneId = context().mainPane.paneId;
  if (!context().layout.has(previous)) registry.remove(previous);
  const doc = currentSession();
  watch(doc);
  updateTitle();
  const usable = waitUntilUsable(payload.documentId);
  perfMark("renderer-send", { path: payload.path, documentId: payload.documentId });
  send("smd:doc", payload);
  syncLayout();
  trace(`doc-sent name=${payload.name} blocks=${payload.blocks.length} intent=${payload.intent}`);
  await usable;
}

function reveal(): void {
  if (!context() || context().win.isDestroyed()) createDocumentWindow();
  if (process.platform === "darwin") void app.dock?.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  if (!context().win.isVisible()) context().win.show();
  context().win.focus();
}

function openFile(file: string | undefined, intent: OpenIntent, inPlace = false): Promise<boolean> {
  if (!context() || context().win.isDestroyed()) createDocumentWindow();
  const host = inPlace ? context() : frontmost;
  return windowScope.run(host, () => documents.run(() => openCurrentFile(file, intent, inPlace)));
}

async function openCurrentFile(file: string | undefined, intent: OpenIntent, inPlace = false): Promise<boolean> {
  if (!file) {
    reveal();
    return true;
  }
  if (!isMarkdown(file)) return false;
  const abs = path.resolve(file);
  const canonical = await fs.promises.realpath(abs).catch(() => abs);
  for (const host of windows.values()) {
    let existing: DocumentId | undefined;
    for (const id of host.layout.state.tabs) {
      const file = registry.get(id)?.path;
      if (file && (file === abs || await fs.promises.realpath(file).catch(() => file) === canonical)) { existing = id; break; }
    }
    if (existing !== undefined) return windowScope.run(host, async () => {
      const usable = waitUntilUsable(existing);
      perfMark("file-open-arrival", { path: abs });
      host.layout.activate(existing);
      syncLayout(); reveal();
      await usable;
      return true;
    });
  }
  if (!inPlace && settings.openIn === "window" && context().layout.state.tabs.length) {
    const host = createDocumentWindow();
    return windowScope.run(host, () => openCurrentFile(abs, intent));
  }
  const replaced = inPlace ? currentSession().documentId : undefined;
  perfMark("file-open-arrival", { path: abs });
  let prepared: DocumentSession | undefined;
  try {
    return await openPreparedDocument({
      prepare: async () => {
        invalidateUrlContext(path.dirname(abs));
        perfMark("read-start", { path: abs });
        const { text, readOnlyReason } = await readDocument(abs);
        perfMark("read-end", { path: abs });
        prepared = registry.create(abs, text, intent, readOnlyReason);
        return payloadFor(prepared, true);
      },
      transition,
      settle: () => inPlace ? settle() : Promise.resolve(true),
      refresh: async (payload) => {
        const latest = await readDocument(abs);
        if (latest.text === payload.text && latest.readOnlyReason === payload.readOnlyReason) return payload;
        if (prepared) registry.remove(prepared.documentId);
        prepared = registry.create(abs, latest.text, intent, latest.readOnlyReason);
        return payloadFor(prepared, true);
      },
      present: async (payload) => {
        reveal();
        if (replaced !== undefined) {
          context().layout.replace(replaced, payload.documentId);
          registry.remove(replaced);
          send("smd:closed", replaced);
        }
        await present(payload);
        addRecent(abs);
      },
    });
  } catch (err) {
    console.error("simple-md: failed to open", abs, err);
    void dialog.showMessageBox(context().win, { type: "error", message: `Couldn’t open “${path.basename(abs)}”.`, detail: String(err) });
    return false;
  } finally {
    if (prepared && !context().layout.has(prepared.documentId)) registry.remove(prepared.documentId);
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

async function saveText(text: string, forceDialog: boolean, documentId: DocumentId): Promise<SaveResult | null> {
  const doc = registry.get(documentId);
  if (!doc || doc.text !== text || doc.readOnlyReason || (doc.conflict && !forceDialog)) return null;
  const revisionId = doc.revisionId;
  let target = doc.path;
  if (!target || forceDialog) {
    const res = await dialog.showSaveDialog(context().win, {
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
    updateTitle();
    send("smd:saved", result);
    return result;
  } catch (err) {
    void dialog.showMessageBox(context().win, { type: "error", message: `Couldn’t save “${path.basename(target)}”.`, detail: String(err) });
    return null;
  }
}

// ───────── links & commands ─────────

async function openLink(href: string, intent: OpenIntent = "edit", newTab = false, current = currentSession()): Promise<boolean> {
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
    return isMarkdown(target) && isMarkdown(canonical) ? openFile(target, intent, !newTab) : false;
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

function runCommand(cmd: Command, target = context().layout.active?.documentId): void {
  const current = target === undefined ? undefined : registry.get(target);
  switch (cmd) {
    case "close-tab":
      if (context().layout.state.tabs.length && target !== undefined) void documents.run(() => closeTab(target));
      else if (!context().win.isDestroyed()) context().win.destroy();
      return;
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

const printWaiters = new Map<number, (error?: string) => void>();

async function withPrintWindow<T>(text: string, use: (w: BrowserWindow, doc: DocPayload) => Promise<T>): Promise<T> {
  const doc = await payloadFor(currentSession(), false, text, "read");
  const pw = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  pw.webContents.on("will-navigate", (event) => event.preventDefault());
  pw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
  const current = currentSession();
  const res = await dialog.showSaveDialog(context().win, {
    defaultPath: path.join(current.path ? path.dirname(current.path) : app.getPath("documents"), `${current.name.replace(/\.[^.]+$/, "")}.pdf`),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (res.canceled || !res.filePath) return;
  await fs.promises.writeFile(res.filePath, await makePdf(text));
  shell.showItemInFolder(res.filePath);
}

async function exportHtml(text: string): Promise<void> {
  const current = currentSession();
  const res = await dialog.showSaveDialog(context().win, {
    defaultPath: path.join(current.path ? path.dirname(current.path) : app.getPath("documents"), `${current.name.replace(/\.[^.]+$/, "")}.html`),
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (res.canceled || !res.filePath) return;
  await fs.promises.writeFile(res.filePath, await makeHtml(text));
  shell.showItemInFolder(res.filePath);
}

async function makeHtml(text: string): Promise<string> {
  const current = currentSession();
  const { title, html } = await withPrintWindow(text, async (pw, doc) => {
    const sources: unknown = await pw.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#doc img'), image => image.currentSrc || image.getAttribute('src') || '')`);
    if (!Array.isArray(sources) || !sources.every((source): source is string => typeof source === "string")) throw new Error("Invalid export images.");
    const embedded = await embedLocalImages(sources, current.path ? urlContext(path.dirname(current.path)) : {});
    const html: unknown = await pw.webContents.executeJavaScript(`(() => {
      const clone = document.querySelector('#doc').cloneNode(true);
      const sources = ${JSON.stringify(embedded)};
      clone.querySelectorAll('img').forEach((image, index) => { image.src = sources[index]; image.removeAttribute('loading'); });
      // Static exports drop local links and failed image candidates to avoid leaking paths.
      clone.querySelectorAll('*').forEach(element => {
        for (const attribute of [...element.attributes]) {
          if (/^file:/i.test(attribute.value) || (attribute.name === 'srcset' && /(?:^|[,\\s])file:/i.test(attribute.value))) element.removeAttribute(attribute.name);
        }
      });
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
  handle("smd:close-tab", id => { const doc = ipcSession(id); return documents.run(() => closeTab(doc.documentId)); });
  handle("smd:ready", () => {
    trace("renderer-ready");
    context().rendererReady = true;
    context().markLoaded();
    return { settings, platform: process.platform, accent: process.platform === "darwin" || process.platform === "win32" ? `#${systemPreferences.getAccentColor().slice(0, 6)}` : "Highlight", performanceTracing: testProfile && process.env.SMD_PERF === "1" };
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
    flushWaiters.get(id)?.({ text: r.text, dirty: r.dirty, documentId: r.documentId, revisionId: r.revisionId, conflict: r.conflict });
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
    const out = await doc.render(revisionId, () => renderBlocks(text, doc.path));
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
  handle("smd:accept-disk", (value, id) => {
    const text = ipcText(value);
    const documentId = ipcDocument(id);
    return documents.run(() => ipcSession(documentId).acceptDisk(text));
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
  handle("smd:open-path", (p, intent, id, inPlace) => { if (inPlace === true) ipcDocument(id); return openFile(ipcText(p), ipcIntent(intent), inPlace === true); });
  handle("smd:open-link", (href, intent, id, newTab) => openLink(ipcText(href), ipcIntent(intent), newTab === true, ipcSession(id)));
  handle("smd:context-menu", async (input, id) => {
    const host = context();
    const doc = ipcSession(id);
    const native = host.nativeContext;
    host.nativeContext = undefined;
    if (!native || JSON.stringify(input) !== JSON.stringify(native)) throw new Error("Stale context menu request.");
    const c = await validateContext(input, urlContext(doc.path ? path.dirname(doc.path) : undefined));
    if (!host.layout.has(doc.documentId) || host.win.isDestroyed()) return null;
    return new Promise<string | null>(resolve => {
      let replacement: string | null = null;
      const menu = Menu.buildFromTemplate(contextTemplate(c, {
        replace: word => { replacement = word; },
        dictionary: word => { host.win.webContents.session.addWordToSpellCheckerDictionary(word); },
        open: (url, newTab) => { void windowScope.run(host, () => openLink(url, doc.intent, newTab, doc)); },
        copy: text => { void clipboard.writeText(text); },
        reveal: url => { void containedLocalFile(url, urlContext(doc.path ? path.dirname(doc.path) : undefined)).then(file => shell.showItemInFolder(file)).catch(() => {}); },
        lookup: () => host.win.webContents.showDefinitionForSelection(),
        share: doc.path ? () => shareDocument(host.win, doc.path!) : undefined,
      }));
      menu.popup({ window: host.win, callback: () => resolve(replacement) });
    });
  });
  handle("smd:set-settings", patch => applySettings(patch));
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
    const commands: readonly string[] = ["close-tab", "move-tab-window", "next-tab", "previous-tab", "split-panes", "stack-panes", "focus-pane", "preferences", "new", "save", "save-as", "toggle-edit", "mode-live", "mode-split", "mode-source", "undo", "redo", "find", "palette", "outline", "zoom-in", "zoom-out", "zoom-reset", "export-pdf", "export-html", "print", "nav-back", "nav-forward", "toggle-task", "reveal", "format-bold", "format-italic", "format-link", "format-code", "format-strike"];
    if (commands.includes(cmd)) runCommand(cmd as Command, id);
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
  tray?.destroy();
  tray = undefined;
  registry.dispose();
  configStore().close();
  settingsWindow?.close();
  flushSettings();
  trace("quit-resources-closed");
  await disposeRenderer();
  trace("quit-worker-stopped");
  for (const host of windows.values()) if (!host.win.isDestroyed()) host.win.destroy();
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
    if (process.platform !== "linux") systemPreferences.on("accent-color-changed", () => applySettings({}, false));
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
  });
}

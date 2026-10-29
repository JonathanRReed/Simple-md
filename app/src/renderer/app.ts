import type { MdxResult, RenderedBlocks } from "../shared/render-core.js";
import { mountRenderedHtml, updateFragments, fragmentTarget } from "./author-html.js";
import { applyImageTheme, currentImageTheme } from "./document-images.js";
import { type Command, DEFAULT_SETTINGS, LIVE_MAX_CHARS, type DocPayload, type EditMode, type RenderedBlock, type Settings, type SaveResult } from "../shared/types.js";
import { bridge } from "./api.js";
import { destroyDiagrams, renderDiagrams } from "./diagrams.js";
import { createPreferences, type PreferencesHandle } from "./preferences.js";
import type { EditorHandle, FormatKind } from "./editor.js";
import {
  type PickerItem,
  closeOverlays,
  closeReadFind,
  hideBanner,
  isFindOpen,
  isPickerOpen,
  openPicker,
  openReadFind,
  showBanner,
  toast,
} from "./ui.js";

const simplemd = bridge();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const docEl = $("doc");
const emptyEl = $("empty");
const readScroll = $("read-scroll");
const readPane = $("read");
const editPane = $("edit");
const editorHost = $("editor-host");
const previewPane = $("preview-pane");
const previewScroll = $("preview-scroll");
const previewEl = $("preview");
const nameEl = $("name");
const dirtyEl = $("dirty");
const hintEl = $("hint");
const modesEl = $("modes");
const editBtn = $("edit-btn");

const root = document.documentElement;

interface DocMeta {
  path: string | null;
  name: string;
  baseUrl: string | null;
}

let settings: Settings = DEFAULT_SETTINGS;
let preferences: PreferencesHandle | null = null;
let meta: DocMeta = { path: null, name: "Untitled", baseUrl: null };
let view: "read" | "edit" = "read";
let editor: EditorHandle | null = null;
let editorLoading: Promise<EditorHandle | null> | null = null;
let hasDoc = false;
let readText = "";
let mountedReadText: string | null = null;
let savedText = "";
let readOnlyReason: string | undefined;
let dirty = false;
let previewTimer: number | undefined;
let autosaveTimer: number | undefined;
let readRenderSeq = 0;
let previewRenderSeq = 0;
let previewWork: Promise<void> | null = null;
let previewPending = false;
let readWork: Promise<void> | null = null;
let readPending: { text: string; keepScroll: boolean; id: number; seq: number } | null = null;
let documentId = 0;
let viewSeq = 0;
let transitioning = false;
let diskConflict = false;
let diskSeq = 0;
let saveQueue = Promise.resolve();

// In-place navigation history for peek-through link clicks. `navigating` marks the next doc as
// history-driven so onDoc doesn't push it as a fresh entry.
const navBack: string[] = [];
const navForward: string[] = [];
let navigating: { target: string; direction: "back" | "forward" } | null = null;

const isMdx = () => /\.mdx$/i.test(meta.path ?? meta.name);
const isReadOnly = () => !!readOnlyReason;
let mdx: MdxResult | undefined;
let lastGoodBlocks: RenderedBlock[] | null = null;

function acceptRender(result: RenderedBlocks, source: string): RenderedBlock[] {
  mdx = result.mdx;
  if (mdx && editor?.getText() === source) editor.setMdx(source, mdx);
  if (!mdx?.error) { lastGoodBlocks = result.blocks; return result.blocks; }
  return lastGoodBlocks ? [...lastGoodBlocks, ...result.blocks.filter((block) => block.key.startsWith("mdx-error"))] : result.blocks;
}
const currentText = () => (editor ? editor.getText() : readText);

// KaTeX styles are loaded from JS because the CSP forbids inline onload handlers, and loaded
// after first paint because math is rare enough to not deserve render-blocking CSS.
const katexCss = new Promise<void>((resolve) => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "katex.min.css";
  link.onload = () => resolve();
  link.onerror = () => resolve();
  document.head.appendChild(link);
});

// ───────── rendering ─────────

// Retained blocks stay attached so diagrams and browser selections survive unchanged renders.
const blockEls = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

function mountBlocks(el: HTMLElement, blocks: RenderedBlock[]): void {
  const prev = blockEls.get(el) ?? new Map<string, HTMLElement>();
  const next = new Map<string, HTMLElement>();
  const fresh: HTMLElement[] = [];
  let cursor = el.firstChild;
  for (const block of blocks) {
    let node = prev.get(block.key);
    if (!node) {
      node = document.createElement("div");
      node.className = "block";
      mountRenderedHtml(node, block, settings.remoteImages);
      fresh.push(node);
    }
    node.dataset.sourceStart = String(block.sourceRange[0]);
    node.dataset.sourceEnd = String(block.sourceRange[1]);
    prev.delete(block.key);
    next.set(block.key, node);
    if (node === cursor) cursor = cursor.nextSibling;
    else el.insertBefore(node, cursor);
  }
  for (const stale of prev.values()) {
    destroyDiagrams(stale);
    stale.remove();
  }
  blockEls.set(el, next);
  updateFragments(el);
  const id = documentId;
  void Promise.all(fresh.map((node) => renderDiagrams(node))).then(() => {
    if (id === documentId && blocks.length) simplemd.perfMarker(id, "diagrams-ready");
  });
}

function renderRead(text: string, keepScroll: boolean): Promise<void> {
  readPending = { text, keepScroll, id: documentId, seq: ++readRenderSeq };
  if (readWork) return readWork;
  readWork = (async () => {
    try {
      while (readPending) {
        const request = readPending;
        readPending = null;
        const top = request.keepScroll ? readScroll.scrollTop : undefined;
        try {
          const result = await simplemd.renderBlocks(request.text, request.id);
          if (request.seq !== readRenderSeq || request.id !== documentId) continue;
          mountBlocks(docEl, acceptRender(result, request.text));
          mountedReadText = request.text;
          document.title = result.title;
          if (top !== undefined) readScroll.scrollTop = top;
          updateHint();
        } catch {
          if (request.seq === readRenderSeq && request.id === documentId) toast("Couldn't render this note.");
        }
      }
    } finally {
      readWork = null;
    }
  })();
  return readWork;
}

function renderPreview(): Promise<void> {
  if (!editor || view !== "edit" || (settings.mode !== "split" && !isMdx())) return Promise.resolve();
  previewPending = true;
  if (previewWork) return previewWork;
  previewWork = (async () => {
    try {
      while (previewPending) {
        previewPending = false;
        if (!editor || view !== "edit" || (settings.mode !== "split" && !isMdx())) break;
        const seq = ++previewRenderSeq;
        const id = documentId;
        const fraction = scrollFraction(previewScroll);
        try {
          const source = editor.getText();
          const result = await simplemd.renderBlocks(source, id);
          if (seq !== previewRenderSeq || id !== documentId || view !== "edit" || editor?.getText() !== source) continue;
          const blocks = acceptRender(result, source);
          if (settings.mode === "split") mountBlocks(previewEl, blocks);
          setScrollFraction(previewScroll, fraction);
        } catch {
          if (seq === previewRenderSeq && id === documentId) toast("Couldn't render this preview.");
        }
      }
    } finally {
      previewWork = null;
    }
  })();
  return previewWork;
}

function schedulePreview(): void {
  ++previewRenderSeq;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void renderPreview(), isMdx() ? 200 : 110);
}

const scrollFraction = (el: HTMLElement) => {
  const room = el.scrollHeight - el.clientHeight;
  return room > 0 ? el.scrollTop / room : 0;
};
const setScrollFraction = (el: HTMLElement, f: number) => {
  el.scrollTop = f * Math.max(0, el.scrollHeight - el.clientHeight);
};

// ───────── chrome ─────────

function updateHint(): void {
  if (view === "edit") {
    hintEl.textContent = "";
    return;
  }
  const words = (readText.match(/\S+/g) ?? []).length;
  const minutes = Math.max(1, Math.round(words / 230));
  hintEl.textContent = hasDoc ? `${words.toLocaleString()} words · ${minutes} min${readOnlyReason ? " · read only" : " · ⏎ to edit"}` : "";
}

function updateChrome(): void {
  nameEl.textContent = meta.name;
  dirtyEl.hidden = !dirty;
  modesEl.hidden = view !== "edit";
  editBtn.hidden = view !== "read" || !hasDoc || isReadOnly();
  for (const b of modesEl.querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === settings.mode));
  }
  readPane.hidden = view !== "read";
  editPane.hidden = view !== "edit";
  editPane.dataset.mode = settings.mode;
  previewPane.hidden = settings.mode !== "split";
  updateHint();
}

function applySettings(s: Settings): void {
  const remoteChanged = settings.remoteImages !== s.remoteImages;
  const modeChanged = settings.mode !== s.mode;
  const vimChanged = settings.vim !== s.vim;
  settings = s;
  root.dataset.theme = s.theme;
  root.style.colorScheme = s.theme === "system" ? "light dark" : s.theme;
  applyImageTheme(document, s.theme);
  preferences?.sync(s);
  root.dataset.width = s.width;
  root.dataset.typeface = s.typeface;
  root.style.setProperty("--zoom", String(s.zoom));
  if (!s.autosave) clearTimeout(autosaveTimer);
  if (editor && modeChanged) {
    editor.setMode(s.mode);
    ++previewRenderSeq;
    if (s.mode === "split") void renderPreview();
  }
  if (editor && vimChanged) editor.setVim(s.vim);
  if (remoteChanged && hasDoc) {
    blockEls.delete(docEl);
    blockEls.delete(previewEl);
    destroyDiagrams(docEl);
    destroyDiagrams(previewEl);
    docEl.replaceChildren();
    previewEl.replaceChildren();
    if (view === "read") void renderRead(currentText(), true);
    if (editor) {
      editor.setMode("source");
      editor.setMode(s.mode);
      if (s.mode === "split") void renderPreview();
    }
  }
  updateChrome();
}

function setDirty(next: boolean): void {
  if (next === dirty) return;
  dirty = next;
  simplemd.setDirty(dirty, documentId);
  dirtyEl.hidden = !dirty;
}

// ───────── editor lifecycle ─────────

function ensureEditor(): Promise<EditorHandle | null> {
  if (editor) return Promise.resolve(editor);
  const id = documentId;
  editorLoading ??= import("./editor.js").then(({ createEditor }) => {
    if (id !== documentId) return null;
    editor = createEditor(editorHost, {
      text: readText,
      mdx,
      mode: settings.mode,
      vim: settings.vim,
      host: {
        renderFragment: (text) => simplemd.renderFragment(text, id),
        baseUrl: () => meta.baseUrl,
        remoteImages: () => settings.remoteImages,
        openLink: (href) => void simplemd.openLink(href),
      },
      onChange(text) {
        if (id !== documentId) return;
        if (view === "read") {
          readText = text;
          void renderRead(text, true);
        }
        setDirty(text !== savedText);
        schedulePreview();
        scheduleAutosave();
      },
      onScroll() {
        if (settings.mode === "split" && editor) setScrollFraction(previewScroll, editor.scrollFraction());
      },
      onImages: (files) => insertImages(files).catch(() => {
        toast("Couldn’t add images.");
        return null;
      }),
    });
    editor.setEditable(!transitioning && !isReadOnly());
    return editor;
  });
  return editorLoading;
}

function dropEditor(): void {
  editor?.destroy();
  editor = null;
  editorLoading = null;
}

async function showEdit(initializing = false): Promise<void> {
  if (!hasDoc || (transitioning && !initializing) || isReadOnly()) return;
  closeReadFind();
  const seq = ++viewSeq;
  const fraction = scrollFraction(readScroll);
  const ed = await ensureEditor();
  if (!ed || seq !== viewSeq || (transitioning && !initializing)) return;
  view = "edit";
  simplemd.editing(documentId);
  updateChrome();
  if (settings.mode === "split") await renderPreview();
  if (seq !== viewSeq) return;
  if (settings.mode === "live" && readText.length > LIVE_MAX_CHARS) {
    toast("This note is large, so Live Preview is off to keep typing fast.");
  }
  requestAnimationFrame(() => {
    if (seq !== viewSeq || view !== "edit" || transitioning) return;
    ed.scroller.scrollTop = fraction * Math.max(0, ed.scroller.scrollHeight - ed.scroller.clientHeight);
    ed.focus();
  });
}

async function showRead(): Promise<void> {
  if (!hasDoc || transitioning) return;
  ++viewSeq;
  ++previewRenderSeq;
  const id = documentId;
  const fraction = editor ? editor.scrollFraction() : scrollFraction(readScroll);
  readText = currentText();
  view = "read";
  updateChrome();
  await renderRead(readText, false);
  if (id !== documentId || view !== "read") return;
  setScrollFraction(readScroll, fraction);
  if (settings.autosave) void saveNow(false, true);
}

// ───────── documents ─────────

async function onDoc(payload: DocPayload): Promise<void> {
  const id = payload.documentId;
  simplemd.perfMarker(id, "renderer-receive");
  ++readRenderSeq;
  ++previewRenderSeq;
  ++viewSeq;
  clearTimeout(previewTimer);
  clearTimeout(autosaveTimer);
  readPending = null;
  previewPending = false;
  closeOverlays();
  const navigation = navigating;
  if (navigation?.target === payload.path && meta.path) {
    const from = navigation.direction === "back" ? navBack : navForward;
    const to = navigation.direction === "back" ? navForward : navBack;
    from.pop();
    to.push(meta.path);
  } else if (meta.path !== null && payload.path !== meta.path) {
    navBack.push(meta.path);
    navForward.length = 0;
  }
  navigating = null;
  documentId = id;
  readOnlyReason = payload.readOnlyReason;
  mdx = payload.mdx;
  lastGoodBlocks = payload.mdx?.error ? null : payload.blocks;
  meta = { path: payload.path, name: payload.name, baseUrl: payload.baseUrl };
  root.dataset.documentPath = payload.path ?? "";
  delete root.dataset.documentPainted;
  delete root.dataset.firstReadable;
  hasDoc = true;
  readText = payload.text;
  savedText = payload.text;
  dirty = false;
  diskConflict = false;
  ++diskSeq;
  hideBanner();
  if (readOnlyReason) showBanner(readOnlyReason, []);
  emptyEl.hidden = true;
  docEl.hidden = false;
  document.title = payload.title;
  dropEditor();
  mountBlocks(previewEl, []);
  const sourceEdit = payload.intent === "edit" && !isReadOnly();
  mountBlocks(docEl, sourceEdit ? [] : payload.blocks);
  mountedReadText = sourceEdit ? null : payload.text;
  readScroll.scrollTop = 0;
  view = "read";
  updateChrome();
  if (payload.intent === "edit" && !isReadOnly()) {
    await showEdit(true);
    if (id !== documentId) return;
  }
  simplemd.perfMarker(id, "renderer-mount");
  // This marker does not await fonts, highlighting completion checks or diagram work.
  // The current worker still highlights before sending the payload.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (id !== documentId) return;
    root.dataset.firstReadable = payload.path ?? "";
    simplemd.perfMarker(id, "first-readable");
    if (payload.intent === "peek" || isReadOnly() || settings.mode === "split") simplemd.perfMarker(id, "fully-highlighted");
  }));
  const sourceOnly = payload.intent === "edit" && !isReadOnly() && settings.mode === "source";
  const visibleRoot = payload.intent === "edit" && !isReadOnly() ? settings.mode === "split" ? previewEl : editorHost : docEl;
  if (!sourceOnly && visibleRoot.querySelector(".katex")) {
    await katexCss;
    await document.fonts.ready;
    if (id !== documentId) return;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (id !== documentId) return;
    root.dataset.documentPainted = payload.path ?? "";
    root.dataset.documentId = String(id);
    simplemd.documentReady(id);
  }));
}

function onSaved(result: SaveResult): void {
  if (result.documentId !== documentId) return;
  const moved = meta.baseUrl !== result.baseUrl;
  meta = { path: result.path, name: result.name, baseUrl: result.baseUrl };
  if (moved) {
    editor?.setMode(settings.mode);
    if (view === "read") void renderRead(currentText(), true);
    else if (settings.mode === "split") void renderPreview();
  }
  savedText = result.text;
  dirty = currentText() !== savedText;
  simplemd.setDirty(dirty, documentId);
  updateChrome();
}

function saveNow(forceDialog: boolean, automatic = false): Promise<void> {
  clearTimeout(autosaveTimer);
  const id = documentId;
  const save = async () => {
    if (!hasDoc || id !== documentId || isReadOnly() || transitioning || diskConflict) return;
    const text = currentText();
    if (automatic && (!meta.path || text === savedText)) return;
    if (!forceDialog && meta.path && text === savedText) return;
    const result = await simplemd.save(text, forceDialog, id);
    if (!result || id !== documentId) return;
    onSaved(result);
    if (forceDialog) toast(`Saved ${result.name}`);
  };
  saveQueue = saveQueue.then(save, save);
  return saveQueue;
}

function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  if (!settings.autosave || !meta.path || !dirty || diskConflict || isReadOnly()) return;
  autosaveTimer = window.setTimeout(() => void saveNow(false, true), 900);
}

function applyDiskText(text: string): void {
  savedText = text;
  readText = text;
  dirty = false;
  simplemd.setDirty(false, documentId);
  editor?.setText(text);
  if (view === "read") void renderRead(text, true);
  else if (settings.mode === "split" || isMdx()) void renderPreview();
  updateChrome();
}

function onDiskChanged(text: string, id: number, reason?: string): void {
  if (id !== documentId) return;
  const seq = ++diskSeq;
  if (reason) {
    readOnlyReason = reason;
    diskConflict = true;
    clearTimeout(autosaveTimer);
    editor?.setEditable(false);
    const reload = async () => {
      if (!(await simplemd.acceptDisk(text, id)) || id !== documentId || seq !== diskSeq) return;
      diskConflict = false;
      applyDiskText(text);
      showBanner(reason, []);
    };
    if (dirty) showBanner(reason, [{ label: "Reload", run: reload }]);
    else void reload();
    updateChrome();
    return;
  }
  const observedText = currentText();
  clearTimeout(autosaveTimer);
  diskConflict = true;
  const offerChoice = () => showBanner("This note changed on disk.", [
    { label: "Reload", run: () => accept(true) },
    { label: "Keep mine", run: () => accept(false) },
  ]);
  const accept = async (reload: boolean, automatic = false) => {
    if (!(await simplemd.acceptDisk(text, id)) || id !== documentId || seq !== diskSeq) return false;
    if (automatic && currentText() !== observedText) {
      offerChoice();
      return false;
    }
    diskConflict = false;
    readOnlyReason = undefined;
    editor?.setEditable(!transitioning && !isReadOnly());
    hideBanner();
    if (reload) applyDiskText(text);
    else {
      savedText = text;
      setDirty(currentText() !== savedText);
      scheduleAutosave();
    }
    return true;
  };
  if (text === observedText || !dirty) void accept(true, true);
  else offerChoice();
}

async function insertImages(files: File[]): Promise<string | null> {
  if (transitioning || isReadOnly()) return null;
  if (!meta.path) {
    toast("Save the note first to add images.");
    return null;
  }
  const id = documentId;
  const target = editor;
  const lines: string[] = [];
  for (const file of files) {
    const ext = file.type.split("/")[1]!.replace("jpeg", "jpg").replace("svg+xml", "svg");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (id !== documentId || transitioning) return null;
    const rel = await simplemd.saveImage(bytes, ext, id);
    if (id !== documentId || target !== editor || transitioning) return null;
    if (rel) lines.push(`![](${rel.split("/").map(encodeURIComponent).join("/").replace(/\(/g, "%28").replace(/\)/g, "%29")})`);
  }
  return lines.length ? `${lines.join("\n")}\n` : null;
}

// ───────── commands & palette ─────────

// Click-to-check in the read/peek view. The checkbox inputs are disabled (and pointer-events:
// none), so clicks land on the <li>; we map the click back to the source by ordinal. The
// The parser maps rendered checkbox order, including relocated footnotes.
async function toggleTask(item: HTMLElement): Promise<void> {
  if (!hasDoc || view !== "read" || transitioning || isReadOnly() || mdx?.error) return;
  if (!meta.path) {
    toast("Save the note first to check off tasks.");
    return;
  }
  const source = mountedReadText;
  if (source === null || source !== readText || readWork || readPending) return;
  const boxes = docEl.querySelectorAll(".task-list-item-checkbox");
  const index = Array.prototype.indexOf.call(boxes, item.querySelector(".task-list-item-checkbox"));
  if (index < 0) return;
  const id = documentId;
  const matchesMountedSource = () => id === documentId && !transitioning && view === "read"
    && source === mountedReadText && source === readText && !readWork && !readPending && docEl.contains(item);
  const { toggleTaskAt } = await import("./tasks.js");
  if (!matchesMountedSource()) return;
  const ed = await ensureEditor();
  if (!ed || !matchesMountedSource()) return;
  const next = toggleTaskAt(source, index, mdx?.ranges);
  if (next === null) {
    toast("Couldn't find that task in the source.");
    return;
  }
  readText = next;
  // Keep a live editor in sync so currentText() and a later showEdit() don't clobber the flip.
  editor?.setText(next, true);
  setDirty(readText !== savedText);
  await renderRead(readText, true);
  // Pulse the re-rendered checkbox (same ordinal in the fresh DOM) as press feedback.
  if (id !== documentId) return;
  docEl.querySelectorAll(".task-list-item-checkbox")[index]?.classList.add("task-pulse");
  if (id === documentId) scheduleAutosave();
}

// Back/forward through notes opened by peek-through links, staying in the current view.
async function navigate(direction: "back" | "forward"): Promise<void> {
  const from = direction === "back" ? navBack : navForward;
  if (!meta.path || !from.length) {
    toast(direction === "back" ? "Nothing to go back to." : "Nothing to go forward to.");
    return;
  }
  if (navigating || transitioning) return;
  const target = from.at(-1)!;
  const navigation = { target, direction };
  navigating = navigation;
  try {
    await simplemd.openPath(target, view === "read" ? "peek" : "edit");
  } finally {
    if (navigating === navigation) navigating = null;
  }
}


function runFormat(kind: FormatKind): void {
  if (view === "edit" && !transitioning) editor?.format(kind);
}

function findInView(): void {
  if (view === "edit") editor?.find();
  else openReadFind(() => undefined);
}

function openOutline(): void {
  const items: PickerItem[] = [];
  if (view === "edit" && editor) {
    for (const h of editor.headings()) {
      items.push({ label: h.text, depth: h.level - 1, run: () => editor?.goTo(h.pos) });
    }
  } else {
    for (const h of docEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
      items.push({ label: h.textContent ?? "", depth: Number(h.tagName[1]) - 1, run: () => h.scrollIntoView({ block: "start" }) });
    }
  }
  if (!items.length) {
    toast("No headings in this note.");
    return;
  }
  openPicker("Go to heading…", items, () => (view === "edit" ? editor?.focus() : undefined));
}

function openPalette(): void {
  const set = (patch: Partial<Settings>) => () => void simplemd.setSettings(patch);
  const cmd = (c: Command) => () => handleCommand(c);
  const items: PickerItem[] = [
    { label: view === "read" ? "Edit this note" : "Read this note", hint: "⌘⏎", run: cmd("toggle-edit") },
    { label: "Preferences…", run: () => handleCommand("preferences") },
    { label: "New note", hint: "⌘N", run: cmd("new") },
    { label: "Open…", hint: "⌘O", run: () => void simplemd.openDialog() },
    { label: "Save", hint: "⌘S", run: cmd("save") },
    { label: "Save as…", hint: "⇧⌘S", run: cmd("save-as") },
    { label: "Go to heading…", hint: "⇧⌘O", run: openOutline },
    { label: "Find in note", hint: "⌘F", run: findInView },
    { label: "Mode: Live preview", hint: "⌥⌘1", run: set({ mode: "live" }) },
    { label: "Mode: Side by side", hint: "⌥⌘2", run: set({ mode: "split" }) },
    { label: "Mode: Source", hint: "⌥⌘3", run: set({ mode: "source" }) },
    { label: "Appearance: System", run: set({ theme: "system" }) },
    { label: "Appearance: Light", run: set({ theme: "light" }) },
    { label: "Appearance: Dark", run: set({ theme: "dark" }) },
    { label: "Typeface: Sans", run: set({ typeface: "sans" }) },
    { label: "Typeface: Serif", run: set({ typeface: "serif" }) },
    { label: "Width: Narrow", run: set({ width: "narrow" }) },
    { label: "Width: Normal", run: set({ width: "normal" }) },
    { label: "Width: Wide", run: set({ width: "wide" }) },
    { label: "Zoom in", hint: "⌘=", run: cmd("zoom-in") },
    { label: "Zoom out", hint: "⌘-", run: cmd("zoom-out") },
    { label: "Actual size", hint: "⌘0", run: cmd("zoom-reset") },
    { label: settings.autosave ? "Turn autosave off" : "Turn autosave on", run: set({ autosave: !settings.autosave }) },
    { label: "Export as PDF…", run: cmd("export-pdf") },
    { label: "Print…", hint: "⌘P", run: cmd("print") },
    { label: "Reveal in file manager", run: cmd("reveal") },
    ...settings.recents.map((p): PickerItem => ({ label: `Open ${p.split(/[\\/]/).pop()}`, hint: p.split(/[\\/]/).slice(-2, -1)[0], run: () => void simplemd.openPath(p) })),
  ];
  openPicker("Type a command…", items, () => (view === "edit" ? editor?.focus() : undefined));
}

function handleCommand(cmd: Command): void {
  if (transitioning && ["toggle-edit", "undo", "redo", "save", "save-as", "format-bold", "format-italic", "format-code", "format-link", "format-strike"].includes(cmd)) return;
  switch (cmd) {
    case "save":
      void saveNow(false);
      break;
    case "save-as":
      void saveNow(true);
      break;
    case "toggle-edit":
      void (view === "read" ? showEdit() : showRead());
      break;
    case "mode-live":
    case "mode-split":
    case "mode-source":
      if (view === "read") void showEdit();
      break;
    case "find":
      findInView();
      break;
    case "preferences":
      closeOverlays();
      preferences?.open();
      break;
    case "palette":
      openPalette();
      break;
    case "outline":
      openOutline();
      break;
    case "nav-back":
      void navigate("back");
      break;
    case "nav-forward":
      void navigate("forward");
      break;
    case "undo":
      editor?.undo();
      break;
    case "redo":
      editor?.redo();
      break;
    case "export-pdf":
      void simplemd.exportPdf(currentText(), documentId);
      break;
    case "export-html":
      void simplemd.exportHtml(currentText(), documentId);
      break;
    case "print":
      void simplemd.print(currentText(), documentId);
      break;
    case "format-bold":
      runFormat("bold");
      break;
    case "format-italic":
      runFormat("italic");
      break;
    case "format-code":
      runFormat("code");
      break;
    case "format-strike":
      runFormat("strike");
      break;
    case "format-link":
      runFormat("link");
      break;
    default:
      simplemd.command(cmd);
  }
}

// ───────── events ─────────

function scrollToFragment(href: string): void {
  const scope = view === "read" ? docEl : previewEl;
  fragmentTarget(scope, href)?.scrollIntoView({ block: "start" });
}

async function navigateLink(href: string): Promise<void> {
  if (href.startsWith("#")) { scrollToFragment(href); return; }
  const fragment = href.includes("#") ? href.slice(href.indexOf("#")) : "";
  if (await simplemd.openLink(href, view === "read" ? "peek" : "edit") && fragment) scrollToFragment(fragment);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyImageTheme(document, currentImageTheme()));

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const copy = target.closest<HTMLButtonElement>(".copy-code");
  if (copy) {
    const code = copy.closest(".code-block")?.querySelector("pre")?.textContent ?? "";
    void navigator.clipboard.writeText(code.replace(/\n$/, "")).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    });
    return;
  }
  // Task-list checkboxes toggle in place in the read view; links inside the item still win.
  const taskItem = target.closest<HTMLElement>(".task-list-item");
  if (taskItem && view === "read" && docEl.contains(taskItem) && !target.closest("a")) {
    void toggleTask(taskItem);
    return;
  }
  const a = target.closest("a");
  if (a && transitioning) {
    e.preventDefault();
    return;
  }
  if (!a || e.defaultPrevented) return;
  const href = a.getAttribute("href") ?? "";
  // The page itself must never navigate, including to a fragment.
  e.preventDefault();
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  void navigateLink(href);
});

document.addEventListener("keydown", (e) => {
  if (preferences?.isOpen() || isPickerOpen() || isFindOpen() || e.defaultPrevented || e.isComposing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (view === "read") {
    if (e.key === "Escape" || (e.key === " " && !mod && !e.shiftKey)) {
      e.preventDefault();
      simplemd.hide();
    } else if (!mod && !e.altKey && (e.key === "Enter" || e.key === "e")) {
      e.preventDefault();
      void showEdit();
    } else if (!mod && !e.altKey && e.key === "t") {
      const order = ["system", "light", "dark"] as const;
      void simplemd.setSettings({ theme: order[(order.indexOf(settings.theme) + 1) % order.length]! });
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    void showRead();
  }
});

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  const handled = e.defaultPrevented;
  e.preventDefault();
  if (handled) return;
  const f = e.dataTransfer?.files[0];
  if (f && !f.type.startsWith("image/")) void simplemd.openPath(simplemd.pathForFile(f));
});

modesEl.addEventListener("click", (e) => {
  const mode = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.mode as EditMode | undefined;
  if (mode) void simplemd.setSettings({ mode });
});
editBtn.addEventListener("click", () => void showEdit());

// ───────── boot ─────────

async function boot(): Promise<void> {
  if (new URLSearchParams(location.search).has("print")) {
    document.body.classList.add("print");
    simplemd.onPrintDoc((doc, s) => {
      applySettings(s);
      emptyEl.hidden = true;
      docEl.hidden = false;
      docEl.replaceChildren();
      for (const block of doc.blocks) {
        const node = document.createElement("div");
        mountRenderedHtml(node, block, s.remoteImages);
        docEl.append(node);
      }
      updateFragments(docEl);
      void renderDiagrams(docEl)
        .then(() => katexCss)
        .then(() => document.fonts.ready)
        .then(() => Promise.all([...docEl.querySelectorAll("img")].filter((image) => image.hasAttribute("src") || image.currentSrc || image.closest("picture")?.querySelector("source[srcset]")).map(async (image) => {
          image.loading = "eager";
          if (!image.complete) await new Promise<void>((resolve, reject) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => reject(new Error("An image could not be loaded for printing.")), { once: true });
          });
          await image.decode();
        })))
        .then(() => simplemd.printReady())
        .catch((error: unknown) => simplemd.printReady(error instanceof Error ? error.message : "Print rendering failed."));
    });
    return;
  }

  simplemd.onTransition((busy) => {
    transitioning = busy;
    editPane.inert = busy;
    readPane.inert = busy;
    editor?.setEditable(!busy && !isReadOnly());
    if (busy) clearTimeout(autosaveTimer);
    else {
      scheduleAutosave();
      if (view === "edit") {
        editor?.focus();
        if (editor) simplemd.perfMarker(documentId, "ready-for-input");
      }
    }
  });
  simplemd.onSaved(onSaved);
  simplemd.onSettings(applySettings);
  simplemd.onDoc((doc) => void onDoc(doc));
  simplemd.onCommand(handleCommand);
  simplemd.onDiskChanged(onDiskChanged);
  simplemd.onFlushRequest((id) => simplemd.flushResponse(id, { dirty, text: currentText(), documentId, conflict: diskConflict }));

  const ready = await simplemd.ready();
  document.body.dataset.platform = ready.platform;
  preferences = createPreferences({ platform: ready.platform, settings: () => settings, change: (patch) => simplemd.setSettings(patch) });
  for (const id of ["preferences-btn", "empty-preferences"]) $(id).addEventListener("click", () => handleCommand("preferences"));
  $("open-file").addEventListener("click", () => void simplemd.openDialog());
  $("new-note").addEventListener("click", () => simplemd.command("new"));
  const hint = $("open-hint");
  if (ready.platform === "darwin") hint.innerHTML = 'Or select a Markdown file in Finder and press <kbd>⌘⇧Space</kbd>';
  else if (ready.platform === "win32") hint.innerHTML = 'Or select a Markdown file in Explorer and press <kbd>Ctrl+Shift+Space</kbd>';
  else hint.innerHTML = 'Press <kbd>Ctrl+Shift+Space</kbd> to choose a file';
  applySettings(ready.settings);

  // Load the editor while the window is idle so the first edit starts instantly.
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  (idle ?? setTimeout)(() => void import("./editor.js"));
}

void boot();

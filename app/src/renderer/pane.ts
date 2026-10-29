import type { HighlightState, GitChangesStatus } from "../shared/change-highlights.js";
import { applyBlockUpdate } from "../shared/block-update.js";
import type { MdxResult, RenderedBlocks } from "../shared/render-core.js";
import { mountRenderedHtml, updateFragments, fragmentTarget } from "./author-html.js";
import { makeDocumentId, makePaneId, makeRevisionId, type DocumentId, type PaneId, type RevisionId, type Command, DEFAULT_SETTINGS, LIVE_MAX_CHARS, type DocPayload, type EditMode, type RenderedBlock, type Settings, type SaveResult } from "../shared/types.js";
import { bridge } from "./api.js";
import { destroyDiagrams, renderDiagrams } from "./diagrams.js";

import type { EditorHandle, EditorSnapshot, FormatKind } from "./editor.js";
import {
  type PickerItem,
  closeOverlays,
  closeReadFind,
  hideBanner as hidePaneBanner,
  isFindOpen,
  isPickerOpen,
  openPicker,
  openReadFind,
  showBanner as showPaneBanner,
  toast,
} from "./ui.js";

interface DocMeta {
  path: string | null;
  name: string;
  baseUrl: string | null;
}

interface DocumentState {
  meta: DocMeta;
  hasDoc: boolean;
  readText: string;
  savedText: string;
  readOnlyReason?: string;
  dirty: boolean;
  diskConflict: boolean;
  diskSeq: number;
  saveQueue: Promise<void>;
  revisionId: RevisionId;
  mdx?: MdxResult;
  lastGoodBlocks: RenderedBlock[] | null;
}
export interface DormantDocument {
  state: DocumentState;
  editor?: EditorSnapshot;
  view: "read" | "edit";
  scroll: number;
  back: string[];
  forward: string[];
  disk?: { text: string; reason?: string };
  seenOnReturn?: RevisionId;
}
export function createPane(container: HTMLElement, paneId: PaneId, options: {
  active(): boolean;
  changed(): void;
}) {
  const simplemd = bridge();
  const hideBanner = () => hidePaneBanner(container);
  const showBanner = (message: string, actions: Parameters<typeof showPaneBanner>[1]) => showPaneBanner(message, actions, container);
  const $ = <T extends HTMLElement>(id: string) => container.querySelector(`[data-element="${id}"]`) as T;

  const docEl = $("doc");
  const emptyEl = $("empty");
  const readScroll = $("read-scroll");
  readScroll.tabIndex = 0;
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
  const modeMenu = container.querySelector<HTMLSelectElement>(".mode-menu")!;
  readScroll.title = "Enter to edit";

  const root = container;

  let settings: Settings = DEFAULT_SETTINGS;
  let retainedEditor: EditorSnapshot | undefined;
  let retainedScroll: number | undefined;
  let disposed = false;
  let navigatingLink = false;
  let pendingDisk: DormantDocument["disk"];
  let highlights: HighlightState = { kind: null, generation: 0, changes: { changed: [], deleted: [] } };
  let gitStatus: GitChangesStatus = { available: false, reason: "Checking Git HEAD..." };
  let changeTimer: number | undefined;
  let changeSequence = 0;
  let changeIndex = -1;
  let changeWork: Promise<void> | undefined;
  let changePending = false;
  let visibleRevision: RevisionId | undefined;
  let visibleSince = 0;
  let seenOnReturn: RevisionId | undefined;
  let active = options.active();

  interface PaneState {
    paneId: PaneId;
    documentId: DocumentId;
    view: "read" | "edit";
    mode: EditMode;
    editor: EditorHandle | null;
    editorLoading: Promise<EditorHandle | null> | null;
    mountedReadText: string | null;
    previewTimer?: number;
    autosaveTimer?: number;
    readRenderSeq: number;
    previewRenderSeq: number;
    previewWork: Promise<void> | null;
    previewPending: boolean;
    readWork: Promise<void> | null;
    readPending: { text: string; keepScroll: boolean; id: DocumentId; revisionId: RevisionId; seq: number } | null;
    viewSeq: number;
  }
  function createDocumentState(): DocumentState {
    return {
      meta: { path: null, name: "Untitled", baseUrl: null },
      hasDoc: false, readText: "", savedText: "", dirty: false,
      diskConflict: false, diskSeq: 0, saveQueue: Promise.resolve(),
      revisionId: makeRevisionId(0), lastGoodBlocks: null,
    };
  }
  function createPaneState(paneId: PaneId, documentId: DocumentId): PaneState {
    return {
      paneId, documentId, view: "read", mode: settings.mode, editor: null, editorLoading: null,
      mountedReadText: null, readRenderSeq: 0, previewRenderSeq: 0,
      previewWork: null, previewPending: false, readWork: null, readPending: null, viewSeq: 0,
    };
  }
  let doc = createDocumentState();
  let pane = createPaneState(paneId, makeDocumentId(0));

  function changedText(text: string): void {
    doc.revisionId = makeRevisionId(doc.revisionId + 1);
    root.dataset.revisionId = String(doc.revisionId);
    simplemd.edit(text, pane.documentId, doc.revisionId);
    visibleRevision = undefined;
    if (highlights.kind) scheduleChanges();
  }

  let transitioning = false;
  // In-place navigation history for sibling link clicks. `navigating` marks the next doc as
  // history-driven so onDoc doesn't push it as a fresh entry.
  const navBack: string[] = [];
  const navForward: string[] = [];
  let navigating: { target: string; direction: "back" | "forward" } | null = null;

  const isMdx = () => /\.mdx$/i.test(doc.meta.path ?? doc.meta.name);
  const isReadOnly = () => !!doc.readOnlyReason;

  function acceptRender(result: RenderedBlocks, source: string): RenderedBlock[] {
    doc.mdx = result.mdx;
    if (doc.mdx && pane.editor?.getText() === source) pane.editor.setMdx(source, doc.mdx);
    if (!doc.mdx?.error) { doc.lastGoodBlocks = result.blocks; return result.blocks; }
    return doc.lastGoodBlocks ? [...doc.lastGoodBlocks, ...result.blocks.filter((block) => block.key.startsWith("mdx-error"))] : result.blocks;
  }
  const activeDocumentId = () => pane.documentId;
  const currentText = () => (pane.editor ? pane.editor.getText() : doc.readText);

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

  function paintChanges(): void {
    const { changed, deleted } = highlights.changes;
    for (const article of [docEl, previewEl]) {
      for (const marker of article.querySelectorAll(":scope > .change-deleted")) marker.remove();
      const blocks = [...article.querySelectorAll<HTMLElement>(":scope > .block")];
      for (const block of blocks) {
        const start = Number(block.dataset.sourceStart), end = Number(block.dataset.sourceEnd);
        block.classList.toggle("change-highlight", changed.some(([a, b]) => start < b && end > a));
      }
      for (const line of deleted) {
        const marker = document.createElement("div");
        marker.className = "change-deleted";
        marker.dataset.sourceStart = String(line);
        marker.title = "Deleted block";
        article.insertBefore(marker, blocks.find(block => Number(block.dataset.sourceStart) >= line) ?? null);
      }
    }
    $("changes").hidden = !changed.length && !deleted.length;
    const count = changed.length + deleted.length;
    $("change-count").textContent = `${count} ${count === 1 ? "change" : "changes"}`;
    $("change-count").title = highlights.kind === "head" ? "Since last commit" : "Since last seen";
    pane.editor?.setChanges(highlights.changes);
  }

  function refreshChanges(): Promise<void> {
    changePending = true;
    if (changeWork) return changeWork;
    const owner = pane;
    changeWork = (async () => {
      while (changePending && !disposed && owner === pane) {
        changePending = false;
        const id = pane.documentId, revision = doc.revisionId, sequence = ++changeSequence;
        try {
          const state = await simplemd.changes(id, revision);
          if (disposed || owner !== pane || id !== pane.documentId || revision !== doc.revisionId || sequence !== changeSequence) continue;
          highlights = state;
          changeIndex = -1;
          visibleRevision = revision;
          visibleSince = performance.now();
          paintChanges();
        } catch (error) {
          if (!disposed && owner === pane && revision === doc.revisionId && sequence === changeSequence) console.warn("simplemd: changes unavailable", error);
        }
      }
    })().finally(() => { if (owner === pane) changeWork = undefined; });
    return changeWork;
  }
  function scheduleChanges(): void {
    ++changeSequence;
    clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => void refreshChanges(), 180);
  }
  async function markSeen(watchOnly = false, revision = doc.revisionId): Promise<void> {
    const id = pane.documentId;
    if (await simplemd.markSeen(id, revision, watchOnly) && id === pane.documentId && !disposed) {
      if (gitStatus.available && !watchOnly) gitStatus = { available: true, active: false };
      await refreshChanges();
    }
  }
  async function toggleHeadChanges(): Promise<void> {
    const id = pane.documentId;
    const status = await simplemd.headChanges(id, highlights.kind !== "head");
    if (id !== pane.documentId || disposed) return;
    gitStatus = status;
    if (!status.available) toast(status.reason);
    await refreshChanges();
  }
  function navigateChange(direction: number): void {
    const lines = [...highlights.changes.changed.map(([start]) => start), ...highlights.changes.deleted].sort((a, b) => a - b);
    if (!lines.length) return;
    changeIndex = (changeIndex + direction + lines.length) % lines.length;
    const line = lines[changeIndex]!;
    if (pane.view === "edit") pane.editor?.scrollToLine(line);
    else {
      const blocks = [...docEl.querySelectorAll<HTMLElement>(":scope > .block, :scope > .change-deleted")];
      (blocks.find(block => Number(block.dataset.sourceStart) >= line) ?? blocks.at(-1))?.scrollIntoView({ block: "center" });
    }
  }
  function activeChanged(next: boolean): void {
    if (next === active) return;
    if (!next) {
      seenOnReturn = highlights.kind === "watch" && visibleRevision === doc.revisionId && performance.now() - visibleSince >= 1000 ? doc.revisionId : undefined;
    } else if (seenOnReturn !== undefined) {
      void markSeen(true, seenOnReturn);
      seenOnReturn = undefined;
    }
    active = next;
  }

  function mountBlocks(el: HTMLElement, blocks: RenderedBlock[], append = false): void {
    const prev = blockEls.get(el) ?? new Map<string, HTMLElement>();
    const next = append ? prev : new Map<string, HTMLElement>();
    const pending = document.createDocumentFragment();
    let cursor = append ? null : el.firstChild;
    for (const block of blocks) {
      let node = prev.get(block.key);
      if (node && node.dataset.fingerprint !== (block.fingerprint ?? block.key)) {
        destroyDiagrams(node);
        mountRenderedHtml(node, block, settings.remoteImages);
      }
      if (!node) {
        node = document.createElement("div");
        node.className = "block";
        mountRenderedHtml(node, block, settings.remoteImages);
      }
      node.dataset.fingerprint = block.fingerprint ?? block.key;
      node.dataset.sourceStart = String(block.sourceRange[0]);
      node.dataset.sourceEnd = String(block.sourceRange[1]);
      prev.delete(block.key);
      next.set(block.key, node);
      if (node === cursor) {
        if (pending.childNodes.length) el.insertBefore(pending, cursor);
        cursor = cursor.nextSibling;
      } else pending.append(node);
    }
    if (pending.childNodes.length) el.insertBefore(pending, cursor);
    for (const stale of append ? [] : prev.values()) {
      destroyDiagrams(stale);
      stale.remove();
    }
    blockEls.set(el, next);
    paintChanges();
    updateFragments(el);
    // renderDiagrams is idempotent per block, so retained blocks only rejoin the readiness wait.
    const id = pane.documentId;
    void Promise.all([...next.values()].map((node) => renderDiagrams(node))).then(() => {
      if (!disposed && id === pane.documentId && blockEls.get(el) === next && blocks.length) simplemd.perfMarker(id, "diagrams-ready");
    });
  }

  async function appendStream(payload: DocPayload, id: DocumentId): Promise<void> {
    const stream = payload.stream;
    if (stream === undefined) return;
    const state = doc;
    const targetPane = pane;
    let blocks = payload.blocks;
    const seq = targetPane.readRenderSeq;
    const live = () => pane === targetPane && id === targetPane.documentId && seq === targetPane.readRenderSeq && targetPane.view === "read";
    try {
      while (live()) {
        const update = await simplemd.nextBlocks(stream, id);
        if (!live()) return;
        if (update.kind === "done") {
          if (!payload.mdx?.error) state.lastGoodBlocks = blocks;
          simplemd.perfMarker(id, "fully-highlighted");
          root.dataset.fullyHighlighted = payload.path ?? "";
          root.dataset.renderComplete = payload.path ?? "";
          return;
        }
        blocks = applyBlockUpdate(blocks, update);
        mountBlocks(docEl, update.kind === "append" ? update.blocks : blocks, update.kind === "append");
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    } catch {
      if (pane === targetPane && id === targetPane.documentId && seq === targetPane.readRenderSeq) toast("Couldn't finish this preview.");
    }
  }

  function renderRead(text: string, keepScroll: boolean): Promise<void> {
    const state = doc;
    const targetPane = pane;
    targetPane.readPending = { text, keepScroll, id: targetPane.documentId, revisionId: state.revisionId, seq: ++targetPane.readRenderSeq };
    if (targetPane.readWork) return targetPane.readWork;
    targetPane.readWork = (async () => {
      try {
        while (targetPane.readPending) {
          const request = targetPane.readPending;
          targetPane.readPending = null;
          const top = request.keepScroll ? readScroll.scrollTop : undefined;
          try {
            const result = await simplemd.renderBlocks(request.text, request.id, request.revisionId);
            if (request.seq !== targetPane.readRenderSeq || disposed || request.id !== activeDocumentId() || request.revisionId !== state.revisionId) continue;
            mountBlocks(docEl, acceptRender(result, request.text));
            targetPane.mountedReadText = request.text;
            document.title = result.title;
            if (top !== undefined) readScroll.scrollTop = top;
            updateHint();
          } catch {
            if (request.seq === targetPane.readRenderSeq && request.id === activeDocumentId() && request.revisionId === state.revisionId) toast("Couldn't render this note.");
          }
        }
      } finally {
        targetPane.readWork = null;
      }
    })();
    return targetPane.readWork;
  }

  function renderPreview(): Promise<void> {
    const state = doc;
    const targetPane = pane;
    if (!targetPane.editor || targetPane.view !== "edit" || (pane.mode !== "split" && !isMdx())) return Promise.resolve();
    targetPane.previewPending = true;
    if (targetPane.previewWork) return targetPane.previewWork;
    targetPane.previewWork = (async () => {
      try {
        while (targetPane.previewPending) {
          targetPane.previewPending = false;
          if (!targetPane.editor || targetPane.view !== "edit" || (pane.mode !== "split" && !isMdx())) break;
          const seq = ++targetPane.previewRenderSeq;
          const id = targetPane.documentId;
          const revisionId = state.revisionId;
          const fraction = scrollFraction(previewScroll);
          try {
            const source = targetPane.editor.getText();
            if (pane.mode !== "split") {
              const result = await simplemd.mdxRanges(source, id, revisionId);
              if (disposed || seq !== targetPane.previewRenderSeq || id !== activeDocumentId() || revisionId !== state.revisionId || targetPane.view !== "edit" || targetPane.editor?.getText() !== source) continue;
              state.mdx = result;
              targetPane.editor.setMdx(source, result);
            } else {
              const result = await simplemd.renderBlocks(source, id, revisionId);
              if (disposed || seq !== targetPane.previewRenderSeq || id !== activeDocumentId() || revisionId !== state.revisionId || targetPane.view !== "edit" || targetPane.editor?.getText() !== source) continue;
              mountBlocks(previewEl, acceptRender(result, source));
            }
            setScrollFraction(previewScroll, fraction);
          } catch {
            if (seq === targetPane.previewRenderSeq && id === activeDocumentId() && revisionId === state.revisionId) toast("Couldn't render this preview.");
          }
        }
      } finally {
        targetPane.previewWork = null;
      }
    })();
    return targetPane.previewWork;
  }

  function schedulePreview(): void {
    ++pane.previewRenderSeq;
    clearTimeout(pane.previewTimer);
    pane.previewTimer = window.setTimeout(() => void renderPreview(), isMdx() ? 200 : 110);
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
    hintEl.hidden = pane.view === "edit" || !doc.hasDoc;
    if (pane.view === "edit") {
      hintEl.textContent = "";
      return;
    }
    const words = (doc.readText.match(/\S+/g) ?? []).length;
    const minutes = Math.max(1, Math.round(words / 230));
    hintEl.textContent = doc.hasDoc ? `${words.toLocaleString()} words · ${minutes} min${doc.readOnlyReason ? " · read only" : ""}` : "";
  }

  function updateChrome(): void {
    nameEl.textContent = doc.meta.name;
    root.dataset.view = pane.view;
    container.querySelector<HTMLElement>(".pane-toolbar")!.title = doc.meta.path ?? doc.meta.name;
    readScroll.title = isReadOnly() ? "Read only" : "Enter to edit";
    modeMenu.hidden = pane.view !== "edit";
    modeMenu.value = pane.mode;
    dirtyEl.hidden = !doc.dirty;
    modesEl.hidden = pane.view !== "edit";
    editBtn.hidden = pane.view !== "read" || !doc.hasDoc || isReadOnly();
    for (const b of modesEl.querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-checked", String(b.dataset.mode === pane.mode));
      b.tabIndex = b.dataset.mode === pane.mode ? 0 : -1;
    }
    readPane.hidden = pane.view !== "read";
    editPane.hidden = pane.view !== "edit";
    editPane.dataset.mode = pane.mode;
    previewPane.hidden = pane.mode !== "split";
    updateHint();
    options.changed();
  }

  function applySettings(s: Settings): void {
    const remoteChanged = settings.remoteImages !== s.remoteImages;

    const vimChanged = settings.vim !== s.vim;
    settings = s;
    if (!s.autosave) clearTimeout(pane.autosaveTimer);
    if (pane.editor && vimChanged) pane.editor.setVim(s.vim);
    if (remoteChanged && doc.hasDoc) {
      blockEls.delete(docEl);
      blockEls.delete(previewEl);
      destroyDiagrams(docEl);
      destroyDiagrams(previewEl);
      docEl.replaceChildren();
      previewEl.replaceChildren();
      if (pane.view === "read") void renderRead(currentText(), true);
      if (pane.editor) {
        pane.editor.setMode("source");
        pane.editor.setMode(pane.mode);
        if (pane.mode === "split") void renderPreview();
      }
    }
    updateChrome();
    pane.editor?.refreshLayout();
  }

  function setDirty(next: boolean): void {
    if (next === doc.dirty) return;
    doc.dirty = next;
    simplemd.setDirty(doc.dirty, pane.documentId);
    dirtyEl.hidden = !doc.dirty;
    options.changed();
  }

  // ───────── editor lifecycle ─────────

  function ensureEditor(): Promise<EditorHandle | null> {
    if (pane.editor) return Promise.resolve(pane.editor);
    const id = pane.documentId;
    const owner = pane;
    pane.editorLoading ??= import("./editor.js").then(({ createEditor }) => {
      if (disposed || owner !== pane || id !== pane.documentId) return null;
      pane.editor = createEditor(editorHost, {
        text: doc.readText,
        snapshot: retainedEditor,
        mdx: doc.mdx,
        mode: pane.mode,
        vim: settings.vim,
        host: {
          renderFragment: async (text) => {
            // CodeMirror can mount widgets before its change listener publishes the edit.
            await Promise.resolve();
            if (id !== pane.documentId) throw new Error("This document has been replaced.");
            return simplemd.renderFragment(text, id, doc.revisionId);
          },
          baseUrl: () => doc.meta.baseUrl,
          remoteImages: () => settings.remoteImages,
          openLink: (href) => void navigateLink(href),
        },
        onChange(text) {
          if (disposed || id !== pane.documentId) return;
          changedText(text);
          doc.readText = text;
          if (pane.view === "read") {
            void renderRead(text, true);
          }
          setDirty(text !== doc.savedText);
          schedulePreview();
          scheduleAutosave();
        },
        onScroll() {
          if (pane.mode === "split" && pane.editor) setScrollFraction(previewScroll, pane.editor.scrollFraction());
        },
        onImages: (files) => insertImages(files).catch(() => {
          toast("Couldn’t add images.");
          return null;
        }),
      });
      retainedEditor = undefined;
      pane.editor.setEditable(!transitioning && !isReadOnly());
      pane.editor.setChanges(highlights.changes);
      return pane.editor;
    });
    return pane.editorLoading;
  }

  function dropEditor(): void {
    pane.editor?.destroy();
    pane.editor = null;
    pane.editorLoading = null;
  }

  async function showEdit(initializing = false, prepared?: RenderedBlock[]): Promise<void> {
    if (!doc.hasDoc || (transitioning && !initializing) || isReadOnly()) return;
    closeReadFind();
    pane.view = "edit";
    const id = pane.documentId;
    const owner = pane;
    const seq = ++pane.viewSeq;
    const fraction = scrollFraction(readScroll);
    const restoring = !!retainedEditor;
    const ed = await ensureEditor();
    if (!ed || pane !== owner || id !== pane.documentId || seq !== pane.viewSeq || (transitioning && !initializing)) return;
    pane.view = "edit";
    simplemd.editing(pane.documentId);
    updateChrome();
    if (pane.mode === "split") {
      if (prepared) mountBlocks(previewEl, prepared);
      else await renderPreview();
    }
    if (pane !== owner || id !== pane.documentId || seq !== pane.viewSeq) return;
    if (pane.mode === "live" && doc.readText.length > LIVE_MAX_CHARS) {
      toast("This note is large, so Live Preview is off to keep typing fast.");
    }
    requestAnimationFrame(() => {
      if (pane !== owner || id !== pane.documentId || seq !== pane.viewSeq || pane.view !== "edit" || transitioning) return;
      if (!restoring) ed.scroller.scrollTop = retainedScroll ?? fraction * Math.max(0, ed.scroller.scrollHeight - ed.scroller.clientHeight);
      retainedScroll = undefined;
      if (options.active() && !document.activeElement?.closest("#tabs")) ed.focus();
    });
  }

  async function showRead(): Promise<void> {
    if (!doc.hasDoc || transitioning) return;
    ++pane.viewSeq;
    ++pane.previewRenderSeq;
    const id = pane.documentId;
    const owner = pane;
    const fraction = pane.editor ? pane.editor.scrollFraction() : scrollFraction(readScroll);
    doc.readText = currentText();
    pane.view = "read";
    updateChrome();
    await renderRead(doc.readText, false);
    if (pane !== owner || id !== pane.documentId || pane.view !== "read") return;
    setScrollFraction(readScroll, fraction);
    if (settings.autosave) void saveNow(false, true);
  }

  // ───────── documents ─────────

  async function onDoc(payload: DocPayload, retained?: DormantDocument): Promise<void> {
    disposed = false;
    clearTimeout(changeTimer);
    ++changeSequence;
    changeWork = undefined;
    changePending = false;
    highlights = { kind: null, generation: 0, changes: { changed: [], deleted: [] } };
    active = options.active();
    seenOnReturn = retained?.seenOnReturn;
    visibleRevision = undefined;
    pendingDisk = undefined;
    const id = payload.documentId;
    const mode = doc.hasDoc ? pane.mode : settings.mode;
    simplemd.perfMarker(id, "renderer-receive");
    ++pane.readRenderSeq;
    ++pane.previewRenderSeq;
    ++pane.viewSeq;
    clearTimeout(pane.previewTimer);
    clearTimeout(pane.autosaveTimer);
    pane.readPending = null;
    pane.previewPending = false;
    closeOverlays();
    const navigation = navigating;
    if (!navigation && !navigatingLink && !retained) { navBack.length = 0; navForward.length = 0; }
    if (navigation?.target === payload.path && doc.meta.path) {
      const from = navigation.direction === "back" ? navBack : navForward;
      const to = navigation.direction === "back" ? navForward : navBack;
      from.pop();
      to.push(doc.meta.path);
    } else if (navigatingLink && doc.meta.path !== null && payload.path !== doc.meta.path) {
      navBack.push(doc.meta.path);
      navForward.length = 0;
    }
    navigating = null;
    navigatingLink = false;
    if (retained) { navBack.splice(0, navBack.length, ...retained.back); navForward.splice(0, navForward.length, ...retained.forward); }
    dropEditor();
    doc = retained?.state ?? createDocumentState();
    if (!retained) doc.revisionId = payload.revisionId;
    root.dataset.revisionId = String(doc.revisionId);
    pane = createPaneState(paneId, id);
    const owner = pane;
    pane.mode = mode;
    simplemd.paneMode(pane.paneId, mode);
    retainedEditor = retained?.editor;
    retainedScroll = retained?.scroll;
    if (!retained) {
      doc.readOnlyReason = payload.readOnlyReason;
      doc.mdx = payload.mdx;
      doc.lastGoodBlocks = payload.mdx?.error || !payload.blocks.length ? null : payload.blocks;
      doc.meta = { path: payload.path, name: payload.name, baseUrl: payload.baseUrl };
    }
    root.dataset.documentPath = payload.path ?? "";
    delete root.dataset.documentPainted;
    delete root.dataset.firstReadable;
    delete root.dataset.fullyHighlighted;
    root.dataset.renderComplete = "";
    doc.hasDoc = true;
    if (!retained) {
      doc.readText = payload.text;
      doc.savedText = payload.savedText ?? payload.text;
      doc.dirty = payload.dirty ?? false;
      doc.diskConflict = false;
      ++doc.diskSeq;
    }
    hideBanner();
    if (doc.readOnlyReason) showBanner(doc.readOnlyReason, []);
    emptyEl.hidden = true;
    docEl.hidden = false;
    document.title = payload.title;
    mountBlocks(previewEl, []);
    const sourceEdit = (retained ? retained.view === "edit" : payload.intent === "edit") && !isReadOnly();
    mountBlocks(docEl, sourceEdit ? [] : doc.lastGoodBlocks ?? payload.blocks);
    pane.mountedReadText = sourceEdit ? null : payload.text;
    readScroll.scrollTop = retained?.scroll ?? 0;
    pane.view = "read";
    updateChrome();
    if (sourceEdit) {
      await showEdit(true, retained || !payload.blocks.length ? undefined : payload.blocks);
      if (disposed || pane !== owner || id !== pane.documentId) return;
    }
    if (retained && !sourceEdit && !doc.lastGoodBlocks) await renderRead(doc.readText, false);
    if (disposed || pane !== owner || id !== pane.documentId) return;
    simplemd.perfMarker(id, "renderer-mount");
    setTimeout(() => {
      if (disposed || pane !== owner || id !== pane.documentId) return;
      if (active && seenOnReturn !== undefined) { void markSeen(true, seenOnReturn); seenOnReturn = undefined; }
      else void refreshChanges();
      void simplemd.gitStatus(id).then(status => { if (!disposed && id === pane.documentId) gitStatus = status; }).catch(console.warn);
    }, 0);
    // This marker does not await fonts, highlighting completion checks or diagram work.

    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (disposed || pane !== owner || id !== pane.documentId) return;
      root.dataset.firstReadable = payload.path ?? "";
      simplemd.perfMarker(id, "first-readable");
      if (!retained && payload.stream !== undefined) void appendStream(payload, id);
      else {
        root.dataset.renderComplete = payload.path ?? "";
        if (payload.intent === "read" || isReadOnly() || pane.mode === "split") simplemd.perfMarker(id, "fully-highlighted");
      }
    }));
    const sourceOnly = payload.intent === "edit" && !isReadOnly() && pane.mode === "source";
    const visibleRoot = payload.intent === "edit" && !isReadOnly() ? pane.mode === "split" ? previewEl : editorHost : docEl;
    if (!sourceOnly && visibleRoot.querySelector(".katex")) {
      await katexCss;
      await document.fonts.ready;
      if (disposed || pane !== owner || id !== pane.documentId) return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (disposed || pane !== owner || id !== pane.documentId) return;
      root.dataset.documentPainted = payload.path ?? "";
      root.dataset.documentId = String(id);
      simplemd.documentReady(id);
    }));
  }

  function onSaved(result: SaveResult): void {
    if (result.documentId !== pane.documentId) return;
    const moved = doc.meta.baseUrl !== result.baseUrl;
    doc.meta = { path: result.path, name: result.name, baseUrl: result.baseUrl };
    if (moved) {
      pane.editor?.setMode(pane.mode);
      if (pane.view === "read") void renderRead(currentText(), true);
      else if (pane.mode === "split") void renderPreview();
    }
    doc.savedText = result.text;
    doc.dirty = currentText() !== doc.savedText;
    simplemd.setDirty(doc.dirty, pane.documentId);
    updateChrome();
  }

  function saveNow(forceDialog: boolean, automatic = false): Promise<void> {
    clearTimeout(pane.autosaveTimer);
    const id = pane.documentId;
    const save = async () => {
      if (!doc.hasDoc || id !== pane.documentId || isReadOnly() || transitioning || doc.diskConflict) return;
      const text = currentText();
      if (automatic && (!doc.meta.path || text === doc.savedText)) return;
      if (!forceDialog && doc.meta.path && text === doc.savedText) return;
      const result = await simplemd.save(text, forceDialog, id);
      if (!result || id !== pane.documentId) return;
      onSaved(result);
      if (forceDialog) toast(`Saved ${result.name}`);
    };
    doc.saveQueue = doc.saveQueue.then(save, save);
    return doc.saveQueue;
  }

  function scheduleAutosave(): void {
    clearTimeout(pane.autosaveTimer);
    if (!settings.autosave || !doc.meta.path || !doc.dirty || doc.diskConflict || isReadOnly()) return;
    pane.autosaveTimer = window.setTimeout(() => void saveNow(false, true), 900);
  }

  function applyDiskText(text: string): void {
    doc.savedText = text;
    doc.readText = text;
    doc.dirty = false;
    simplemd.setDirty(false, pane.documentId);
    changedText(text);
    pane.editor?.setText(text);
    if (pane.view === "read") void renderRead(text, true);
    else if (pane.mode === "split" || isMdx()) void renderPreview();
    updateChrome();
  }

  function onDiskChanged(text: string, id: DocumentId, reason?: string): void {
    pendingDisk = { text, reason };
    if (disposed || id !== pane.documentId) return;
    const seq = ++doc.diskSeq;
    if (reason) {
      doc.readOnlyReason = reason;
      doc.diskConflict = true;
      clearTimeout(pane.autosaveTimer);
      pane.editor?.setEditable(false);
      const reload = async () => {
        if (!(await simplemd.acceptDisk(text, id)) || id !== pane.documentId || seq !== doc.diskSeq) return;
        pendingDisk = undefined;
        doc.diskConflict = false;
        applyDiskText(text);
        showBanner(reason, []);
      };
      if (doc.dirty) showBanner(reason, [{ label: "Reload", run: reload }]);
      else void reload();
      updateChrome();
      return;
    }
    const observedText = currentText();
    clearTimeout(pane.autosaveTimer);
    doc.diskConflict = true;
    const offerChoice = () => showBanner("This note changed on disk.", [
      { label: "Reload", run: () => accept(true) },
      { label: "Keep mine", run: () => accept(false) },
    ]);
    const accept = async (reload: boolean, automatic = false) => {
      if (!(await simplemd.acceptDisk(text, id, automatic)) || id !== pane.documentId || seq !== doc.diskSeq) return false;
      if (automatic && currentText() !== observedText) {
        offerChoice();
        return false;
      }
      pendingDisk = undefined;
      doc.diskConflict = false;
      doc.readOnlyReason = undefined;
      pane.editor?.setEditable(!transitioning && !isReadOnly());
      hideBanner();
      if (reload) { applyDiskText(text); void refreshChanges(); }
      else {
        doc.savedText = text;
        setDirty(currentText() !== doc.savedText);
        scheduleAutosave();
      }
      return true;
    };
    if (text === observedText || !doc.dirty) void accept(true, true);
    else offerChoice();
  }

  async function insertImages(files: File[]): Promise<string | null> {
    if (transitioning || isReadOnly()) return null;
    if (!doc.meta.path) {
      toast("Save the note first to add images.");
      return null;
    }
    const id = pane.documentId;
    const target = pane.editor;
    const lines: string[] = [];
    for (const file of files) {
      const ext = file.type.split("/")[1]!.replace("jpeg", "jpg").replace("svg+xml", "svg");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (id !== pane.documentId || transitioning) return null;
      const rel = await simplemd.saveImage(bytes, ext, id);
      if (id !== pane.documentId || target !== pane.editor || transitioning) return null;
      if (rel) lines.push(`![](${rel.split("/").map(encodeURIComponent).join("/").replace(/\(/g, "%28").replace(/\)/g, "%29")})`);
    }
    return lines.length ? `${lines.join("\n")}\n` : null;
  }

  // ───────── commands & palette ─────────

  // Click-to-check in the reading view. The checkbox inputs are disabled (and pointer-events:
  // none), so clicks land on the <li>; we map the click back to the source by ordinal. The
  // The parser maps rendered checkbox order, including relocated footnotes.
  async function toggleTask(item: HTMLElement): Promise<void> {
    if (!doc.hasDoc || pane.view !== "read" || transitioning || isReadOnly() || doc.mdx?.error) return;
    if (!doc.meta.path) {
      toast("Save the note first to check off tasks.");
      return;
    }
    const source = pane.mountedReadText;
    if (source === null || source !== doc.readText || pane.readWork || pane.readPending) return;
    const boxes = docEl.querySelectorAll(".task-list-item-checkbox");
    const index = Array.prototype.indexOf.call(boxes, item.querySelector(".task-list-item-checkbox"));
    if (index < 0) return;
    const id = pane.documentId;
    const matchesMountedSource = () => id === pane.documentId && !transitioning && pane.view === "read"
      && source === pane.mountedReadText && source === doc.readText && !pane.readWork && !pane.readPending && docEl.contains(item);
    const { toggleTaskAt } = await import("./tasks.js");
    if (!matchesMountedSource()) return;
    const ed = await ensureEditor();
    if (!ed || !matchesMountedSource()) return;
    const next = toggleTaskAt(source, index, doc.mdx?.ranges);
    if (next === null) {
      toast("Couldn't find that task in the source.");
      return;
    }
    doc.readText = next;
    changedText(next);
    // Keep a live editor in sync so currentText() and a later showEdit() don't clobber the flip.
    pane.editor?.setText(next, true);
    setDirty(doc.readText !== doc.savedText);
    await renderRead(doc.readText, true);
    if (disposed || id !== pane.documentId) return;
    if (!disposed && id === pane.documentId) scheduleAutosave();
  }

  // Back/forward through notes opened by sibling links, staying in the current view.
  async function navigate(direction: "back" | "forward"): Promise<void> {
    const from = direction === "back" ? navBack : navForward;
    if (!doc.meta.path || !from.length) {
      toast(direction === "back" ? "Nothing to go back to." : "Nothing to go forward to.");
      return;
    }
    if (navigating || transitioning) return;
    const target = from.at(-1)!;
    const navigation = { target, direction };
    navigating = navigation;
    try {
      await simplemd.openPath(target, pane.view === "read" ? "read" : "edit", true, pane.documentId);
    } finally {
      if (navigating === navigation) navigating = null;
    }
  }


  function runFormat(kind: FormatKind): void {
    if (pane.view === "edit" && !transitioning) pane.editor?.format(kind);
  }

  async function findInView(): Promise<void> {
    const id = pane.documentId;
    const text = await simplemd.readFindText();
    if (disposed || pane.documentId !== id) return;
    if (pane.view === "edit") pane.editor?.find(text);
    else openReadFind(() => undefined, text);
  }

  function openOutline(): void {
    const items: PickerItem[] = [];
    if (pane.view === "edit" && pane.editor) {
      for (const h of pane.editor.headings()) {
        items.push({ label: h.text, depth: h.level - 1, run: () => pane.editor?.goTo(h.pos) });
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
    openPicker("Go to heading…", items, () => (pane.view === "edit" ? pane.editor?.focus() : undefined));
  }

  function openPalette(): void {
    const set = (patch: Partial<Settings>) => () => { if (patch.mode) setMode(patch.mode); else void simplemd.setSettings(patch); };
    const cmd = (c: Command) => () => handleCommand(c);
    const items: PickerItem[] = [
      { label: "Mark Seen", run: cmd("mark-seen") },
      { label: "Next Change", run: cmd("next-change") },
      { label: "Previous Change", run: cmd("previous-change") },
      ...(gitStatus.available ? [{ label: "Show Changes Since Last Commit", run: cmd("toggle-head-changes") }] : []),
      { label: pane.view === "read" ? "Edit this note" : "Read this note", hint: "⌘⏎", run: cmd("toggle-edit") },
      { label: "Settings…", run: () => handleCommand("preferences") },
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
      { label: "GitHub style", run: set({ readingStyle: settings.readingStyle === "github" ? "editorial" : "github" }) },
      { label: "Reading font: System", run: set({ readingFontFamily: "system-ui" }) },
      { label: "Reading font: Charter", run: set({ readingFontFamily: "Charter" }) },
      { label: "Width: Narrow", run: set({ contentWidth: 54 }) },
      { label: "Width: Normal", run: set({ contentWidth: 66 }) },
      { label: "Width: Wide", run: set({ contentWidth: 100 }) },
      { label: "Zoom in", hint: "⌘=", run: cmd("zoom-in") },
      { label: "Zoom out", hint: "⌘-", run: cmd("zoom-out") },
      { label: "Actual size", hint: "⌘0", run: cmd("zoom-reset") },
      { label: settings.autosave ? "Turn autosave off" : "Turn autosave on", run: set({ autosave: !settings.autosave }) },
      { label: "Export as PDF…", run: cmd("export-pdf") },
      { label: "Print…", hint: "⌘P", run: cmd("print") },
      { label: "Reveal in file manager", run: cmd("reveal") },
      ...settings.recents.map((p): PickerItem => ({ label: `Open ${p.split(/[\\/]/).pop()}`, hint: p.split(/[\\/]/).slice(-2, -1)[0], run: () => void simplemd.openPath(p) })),
    ];
    openPicker("Type a command…", items, () => (pane.view === "edit" ? pane.editor?.focus() : undefined));
  }

  function handleCommand(cmd: Command): void {
    if (transitioning && ["toggle-edit", "undo", "redo", "save", "save-as", "format-bold", "format-italic", "format-code", "format-link", "format-strike"].includes(cmd)) return;
    switch (cmd) {
      case "mark-seen": void markSeen(); return;
      case "toggle-head-changes": void toggleHeadChanges().catch(error => toast(String(error))); return;
      case "next-change": navigateChange(1); return;
      case "previous-change": navigateChange(-1); return;
      case "save":
        void saveNow(false);
        break;
      case "save-as":
        void saveNow(true);
        break;
      case "toggle-edit":
        void (pane.view === "read" ? showEdit() : showRead());
        break;
      case "mode-live":
      case "mode-split":
      case "mode-source":
        setMode(cmd === "mode-live" ? "live" : cmd === "mode-split" ? "split" : "source");
        if (pane.view === "read") void showEdit();
        break;
      case "use-selection-find":
        void simplemd.writeFindText(pane.view === "edit" ? pane.editor?.selection() ?? "" : window.getSelection()?.toString() ?? "");
        break;
      case "find":
        findInView();
        break;
      case "preferences":
        closeOverlays();
        simplemd.command("preferences");
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
        pane.editor?.undo();
        break;
      case "redo":
        pane.editor?.redo();
        break;
      case "export-pdf":
        void simplemd.exportPdf(currentText(), pane.documentId);
        break;
      case "export-html":
        void simplemd.exportHtml(currentText(), pane.documentId);
        break;
      case "print":
        void simplemd.print(currentText(), pane.documentId);
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
        simplemd.command(cmd, pane.documentId);
    }
  }

  // ───────── events ─────────

  function scrollToFragment(href: string): void {
    if (pane.view === "edit" && pane.mode !== "split" && pane.editor) {
      const source = pane.editor.getText();
      const scope = document.createElement("div");
      for (const block of doc.lastGoodBlocks ?? []) {
        const element = document.createElement("div");
        element.dataset.sourceStart = String(block.sourceRange[0]);
        mountRenderedHtml(element, block, settings.remoteImages);
        scope.append(element);
      }
      updateFragments(scope);
      const target = fragmentTarget(scope, href)?.closest<HTMLElement>("[data-source-start]");
      if (target) {
        const line = Number(target.dataset.sourceStart);
        const breaks = [...source.matchAll(/\r\n|[\r\n]/g)];
        const previous = breaks[line - 1];
        pane.editor.goTo(previous ? previous.index + previous[0].length : 0);
      }
      return;
    }
    const scope = pane.view === "read" ? docEl : previewEl;
    fragmentTarget(scope, href)?.scrollIntoView({ block: "start" });
  }

  async function navigateLink(href: string, newTab = false): Promise<void> {
    if (href.startsWith("#")) { scrollToFragment(href); return; }
    const fragment = href.includes("#") ? href.slice(href.indexOf("#")) : "";
    navigatingLink = !newTab;
    try {
      if (await simplemd.openLink(href, pane.view === "read" ? "read" : "edit", newTab, pane.documentId) && fragment && !newTab) scrollToFragment(fragment);
    } finally { navigatingLink = false; }
  }

  container.addEventListener("click", (e) => {
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
    if (taskItem && pane.view === "read" && docEl.contains(taskItem) && !target.closest("a")) {
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
    if (e.button !== 0 || e.shiftKey || e.altKey) return;
    void navigateLink(href, e.metaKey || e.ctrlKey);
  });

  container.addEventListener("keydown", (e) => {
    if (isPickerOpen() || isFindOpen() || e.defaultPrevented || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (pane.view === "read") {
      if (!mod && !e.altKey && (e.key === "Enter" || e.key === "e")) {
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

  modesEl.addEventListener("click", (e) => {
    const mode = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.mode as EditMode | undefined;
    if (mode) setMode(mode);
  });
  modesEl.addEventListener("keydown", e => {
    const modes: EditMode[] = ["live", "split", "source"];
    const index = modes.indexOf(pane.mode);
    const next = e.key === "Home" ? modes[0] : e.key === "End" ? modes[2]
      : ["ArrowRight", "ArrowDown"].includes(e.key) ? modes[(index + 1) % modes.length]
      : ["ArrowLeft", "ArrowUp"].includes(e.key) ? modes[(index + modes.length - 1) % modes.length] : undefined;
    if (next) { e.preventDefault(); setMode(next); modesEl.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus(); }
  });
  modeMenu.addEventListener("change", () => {
    const mode = modeMenu.value;
    if (mode === "live" || mode === "split" || mode === "source") setMode(mode);
  });
  editBtn.addEventListener("click", () => void showEdit());
  $("mark-seen").addEventListener("click", () => void markSeen());
  $("next-change").addEventListener("click", () => navigateChange(1));
  $("previous-change").addEventListener("click", () => navigateChange(-1));

  function setMode(mode: EditMode): void {
    pane.mode = mode;
    simplemd.paneMode(pane.paneId, mode);
    pane.editor?.setMode(mode);
    ++pane.previewRenderSeq;
    if (mode === "split") void renderPreview();
    updateChrome();
  }
  function suspend(): DormantDocument {
    activeChanged(false);
    doc.readText = currentText();
    if (settings.autosave && doc.dirty && doc.meta.path && !doc.diskConflict && !isReadOnly()) {
      const retained = doc;
      const id = pane.documentId;
      const text = retained.readText;
      const save = async () => {
        const result = await simplemd.save(text, false, id);
        if (!result) return;
        retained.savedText = result.text;
        retained.dirty = retained.readText !== result.text;
        options.changed();
      };
      retained.saveQueue = retained.saveQueue.then(save, save).catch(error => console.error("simplemd: dormant autosave failed", error));
    }
    const snapshot: DormantDocument = {
      state: doc, editor: pane.editor?.snapshot() ?? retainedEditor,
      view: pane.view,
      scroll: pane.view === "edit" ? pane.editor?.scroller.scrollTop ?? 0 : readScroll.scrollTop,
      back: [...navBack], forward: [...navForward], disk: pendingDisk, seenOnReturn,
    };
    disposed = true;
    clearTimeout(changeTimer); ++changeSequence;
    simplemd.releaseView(pane.documentId);
    if (!doc.mdx?.error) doc.lastGoodBlocks = null;
    ++pane.readRenderSeq; ++pane.previewRenderSeq; ++pane.viewSeq;
    clearTimeout(pane.previewTimer); clearTimeout(pane.autosaveTimer);
    pane.readPending = null; pane.previewPending = false;
    dropEditor();
    destroyDiagrams(docEl); destroyDiagrams(previewEl);
    docEl.replaceChildren(); previewEl.replaceChildren();
    blockEls.delete(docEl); blockEls.delete(previewEl);
    return snapshot;
  }
  return {
    async contextMenu(context: import("../shared/native-context.js").NativeContext) {
      const id = pane.documentId;
      const request = async () => {
        const result = await simplemd.contextMenu(context, id);
        if (disposed || pane.documentId !== id) return null;
        if (result?.kind === "fragment") { await navigateLink(result.href); return null; }
        return result;
      };
      if (context.editable && pane.editor) await pane.editor.contextMenu(context, request);
      else await request();
    },
    activeChanged,
    load: onDoc, suspend, settings: applySettings, command: handleCommand, saved: onSaved, diskChanged: onDiskChanged,
    focus() { if (pane.view === "edit") pane.editor?.focus(); else readScroll.focus(); },
    get documentId() { return pane.documentId; },
    get meta() { return { ...doc.meta, dirty: doc.dirty }; },
    transition(busy: boolean) {
      transitioning = busy;
      editPane.inert = busy; readPane.inert = busy;
      pane.editor?.setEditable(!busy && !isReadOnly());
      if (busy) clearTimeout(pane.autosaveTimer);
      else {
        scheduleAutosave();
        if (pane.view === "edit" && options.active() && !document.activeElement?.closest("#tabs")) {
          pane.editor?.focus();
          if (pane.editor) simplemd.perfMarker(pane.documentId, "ready-for-input");
        }
      }
    },
    flush() { return { revisionId: doc.revisionId, dirty: doc.dirty, text: currentText(), documentId: pane.documentId, conflict: doc.diskConflict }; },
  };
}
export type PaneController = ReturnType<typeof createPane>;

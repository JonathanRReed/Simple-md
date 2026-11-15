import { livePreviewOff } from "../shared/live-preview.js";
import { inlineTransaction, type FormatKind } from "./inline-commands.js";
export type { FormatKind } from "./inline-commands.js";
import { writingDefaultKeymap } from "./editor-bindings.js";
import { blockEdit, type BlockCommand } from "./block-commands.js";
import { tableEdit, type TableCommand } from "./table-source.js";
import { sourceTransaction, sourceSelection, sourcePosition } from "./source-transaction.js";
import { writingFolding, runFold, type FoldCommand } from "./folding.js";
import { insertSource, type SourceSelection } from "./source-edit.js";
import { canPasteLink } from "./paste-context.js";
import { deriveOutline, type OutlineItem } from "./outline-model.js";
import type { SourceAnchor } from "./scroll-sync.js";
import { changeMarks, setChangeMarks } from "./change-marks.js";
import type { BlockChanges } from "../shared/change-highlights.js";
import { retainEditorState } from "./editor-history.js";
import { spellingReplacement } from "./spelling.js";
import type { ContextResult, NativeContext } from "../shared/native-context.js";
import type { MdxResult } from "../shared/render-core.js";
import { mdxSyntax, setMdxRanges } from "./mdx-syntax.js";
import { editorMdxRanges } from "./mdx-positions.js";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { history, historyField, historyKeymap, indentWithTab, isolateHistory, redo, undo } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { bracketMatching, ensureSyntaxTree, syntaxTree, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { SearchQuery, getSearchQuery, setSearchQuery, openSearchPanel, search, searchKeymap, findNext, findPrevious, gotoLine } from "@codemirror/search";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, keymap } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { type EditMode } from "../shared/types.js";
import { type LiveHost, clearLiveCache, frontmatterExtension, liveExtension } from "./live.js";
import { tableKeymap } from "./tables.js";
import { codeFont } from "./code-font.js";
import { editorText } from "./editor-text.js";
import { byteText, parseByteText, restoreByteText } from "./byte-text.js";

export interface EditorSnapshot {
  state: EditorState;
  scroll: ReturnType<EditorView["scrollSnapshot"]>;
}

export interface EditorOptions {
  text: string;
  filename?: string;
  isMdx?(): boolean;
  snapshot?: EditorSnapshot;
  mdx?: MdxResult;
  mode: EditMode;
  host: LiveHost;
  /** Modal vim key bindings; applies in every edit mode. Default off. */
  vim?: boolean;
  onChange(text: string): void;
  onSelectionChange?(): void;
  onScroll(): void;
  onOutlineChange?(): void;
  onLiveFallback?(off: boolean): void;
  onImages(files: File[]): Promise<string | null>;
}

export interface Heading {
  level: number;
  text: string;
  pos: number;
}

export interface EditorHandle {
  contextMenu(context: NativeContext, request: () => Promise<ContextResult>): Promise<void>;
  getText(): string;
  snapshot(): EditorSnapshot;
  setChanges(changes: BlockChanges): void;
  scrollToLine(line: number): void;
  setMdx(source: string, result: MdxResult): void;
  /** Replaces the document while keeping the cursor and scroll position near where they were. */
  setText(text: string, addToHistory?: boolean): void;
  setEditable(editable: boolean): void;
  setMode(mode: EditMode): void;
  setVim(on: boolean): void;
  focus(): void;
  refreshLayout(): void;
  format(kind: FormatKind): void;
  block(command: BlockCommand): void;
  table(command: TableCommand): void;
  inTable(): boolean;
  fold(command: FoldCommand): void;
  sourceSelection(): SourceSelection;
  insertAsync(getText: () => Promise<string | null>): Promise<void>;
  replace(): void;
  goToLine(): void;
  selection(): string;
  find(text?: string): void;
  findNext(backwards?: boolean): void;
  undo(): void;
  redo(): void;
  headings(): Heading[];
  outlineItems(levels: number): OutlineItem<number>[];
  outlineOffset(pos: number): number;
  goTo(pos: number): void;
  scrollFraction(): number;
  sourceAnchor(): SourceAnchor;
  restoreAnchor(anchor: SourceAnchor): void;
  scroller: HTMLElement;
  destroy(): void;
}

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml|avif)$/;

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  const initial = parseByteText(opts.text);
  const liveSlot = new Compartment();
  const historySlot = new Compartment();
  const vimSlot = new Compartment();
  const editableSlot = new Compartment();
  const edgeScrollSlot = new Compartment();
  let edgeScrollSequence = 0;
  let edgeScrollActive = false;
  let followEditorEnd = false;
  let edgeScrollQueued = false;
  let mode = opts.mode;
  let vimOn = opts.vim ?? false;
  let silent = false;
  let destroyed = false;
  let vimSeq = 0;
  let contextPosition: number | null = null;
  let countedDoc: EditorState["doc"] | undefined;
  let countedQuery: SearchQuery | undefined;
  let searchMatches: { from: number; to: number }[] = [];
  let countFrame = 0;
  const insertions = new Set<{ from: number; to: number }>();

  const gitCommit = /(?:^|[/\\])(?:COMMIT_EDITMSG|MERGE_MSG|SQUASH_MSG|TAG_EDITMSG|NOTES_EDITMSG)$/.test(opts.filename ?? "");
  let notifiedFallback = false;
  const liveFor = (m: EditMode, length: number) => gitCommit ? [] : m === "live" && !livePreviewOff(length, m, gitCommit) ? liveExtension(opts.host) : [codeFont];

  const view = new EditorView({
    parent,
    scrollTo: opts.snapshot?.scroll,
    state: EditorState.create({
      doc: opts.snapshot?.state.doc ?? initial.text,
      selection: opts.snapshot?.state.selection,
      extensions: [
        historySlot.of([history({ minDepth: 100 }), ...(opts.snapshot ? [historyField.init(() => opts.snapshot!.state.field(historyField))] : [])]),
        byteText.init(() => opts.snapshot?.state.field(byteText) ?? initial.format),
        editorText,
        changeMarks,
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        EditorState.allowMultipleSelections.of(true),
        search({ top: true }),
        ...(!gitCommit ? [markdown({ base: markdownLanguage, codeLanguages: languages, pasteURLAsLink: false, htmlTagLanguage: html({ autoCloseTags: false, matchClosingTags: false }) }), syntaxHighlighting(classHighlighter)] : []),
        ...(opts.mdx ? [mdxSyntax(editorMdxRanges(opts.text, opts.mdx))] : []),
        frontmatterExtension,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Document", spellcheck: "true", autocapitalize: "sentences" }),
        keymap.of([...closeBracketsKeymap, ...writingDefaultKeymap, ...historyKeymap, ...searchKeymap.filter(binding => binding.key !== "Mod-f" && binding.key !== "Mod-g" && binding.key !== "Mod-Shift-g" && binding.key !== "Mod-Alt-g"), indentWithTab]),
        tableKeymap,
        writingFolding,
        edgeScrollSlot.of([]),
        vimSlot.of([]),
        editableSlot.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
        liveSlot.of(liveFor(mode, opts.snapshot?.state.doc.length ?? initial.text.length)),
        EditorState.transactionExtender.of(tr => {
          if (!tr.docChanged || livePreviewOff(tr.startState.doc.length, mode, gitCommit) === livePreviewOff(tr.newDoc.length, mode, gitCommit)) return null;
          return { effects: liveSlot.reconfigure(liveFor(mode, tr.newDoc.length)) };
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) releaseEdgeScroll();
          else if (update.geometryChanged) requestEndRestore();
          cancelAnimationFrame(countFrame);
          countFrame = requestAnimationFrame(() => {
            if (destroyed) return;
            const panel = view.dom.querySelector(".cm-search");
            if (!panel) return;
            const query = getSearchQuery(view.state);
            if (countedDoc !== view.state.doc || !countedQuery?.eq(query)) {
              countedDoc = view.state.doc; countedQuery = query; searchMatches = [];
              if (query.valid) {
                const cursor = query.getCursor(view.state);
                for (let match = cursor.next(); !match.done; match = cursor.next()) searchMatches.push(match.value);
              }
            }
            let count = panel.querySelector<HTMLOutputElement>(".search-count");
            if (!count) {
              count = document.createElement("output"); count.className = "search-count"; count.setAttribute("role", "status");
              panel.querySelector('[name="search"]')?.after(count);
            }
            const selection = view.state.selection.main;
            const current = searchMatches.findIndex(match => match.from === selection.from && match.to === selection.to);
            count.textContent = current < 0 ? `${searchMatches.length} ${searchMatches.length === 1 ? "match" : "matches"}` : `${current + 1} of ${searchMatches.length}`;
          });
          if (update.docChanged) for (const range of insertions) {
            const empty = range.from === range.to;
            range.from = update.changes.mapPos(range.from, 1);
            range.to = Math.max(range.from, update.changes.mapPos(range.to, empty ? 1 : -1));
          }
          const off = livePreviewOff(update.state.doc.length, mode, gitCommit);
          if (off !== notifiedFallback) { notifiedFallback = off; opts.onLiveFallback?.(off); }
          if (update.docChanged || update.selectionSet) opts.onSelectionChange?.();
          if (update.docChanged && !silent) opts.onChange(update.state.field(editorText).text);
          if (update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state) || update.heightChanged) opts.onOutlineChange?.();
        }),
        EditorView.domEventHandlers({
          contextmenu(event, v) {
            contextPosition = v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head;
            return false;
          },
          keydown(event) {
            // app.ts turns Escape in the edit view into "back to read mode", which
            // would yank vim out from under the user. Vim-handled Escapes arrive
            // already preventDefaulted (the app skips those); stop the rest here.
            if (vimOn && event.key === "Escape") event.stopPropagation();
            return false;
          },
          scroll: () => {
            const scroller = view.scrollDOM;
            if (followEditorEnd && scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1) requestEndRestore();
            opts.onScroll();
          },
          paste(event, v) {
            if (v.state.readOnly) return false;
            const data = event.clipboardData;
            if (!data) return false;
            const images = [...data.files].filter((f) => IMAGE_TYPES.test(f.type));
            if (images.length) {
              event.preventDefault();
              void importImages(images, null);
              return true;
            }
            const text = data.getData("text/plain").trim();
            const sel = v.state.selection.main;
            if (canPasteLink(v.state) && /^https?:\/\/\S+$/.test(text)) {
              event.preventDefault();
              const label = v.state.sliceDoc(sel.from, sel.to);
              v.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${label}](${text})` }, userEvent: "input.paste" });
              return true;
            }
            return false;
          },
          drop(event, v) {
            if (v.state.readOnly) return false;
            const images = [...(event.dataTransfer?.files ?? [])].filter((f) => IMAGE_TYPES.test(f.type));
            if (!images.length) return false;
            event.preventDefault();
            void importImages(images, v.posAtCoords({ x: event.clientX, y: event.clientY }));
            return true;
          },
        }),
      ],
    }),
  });

  const edgeInputs = new AbortController();
  for (const event of ["wheel", "pointerdown", "touchstart", "keydown"]) parent.addEventListener(event, releaseEdgeScroll, { capture: true, passive: true, signal: edgeInputs.signal });
  function requestEndRestore(): void {
    if (!followEditorEnd || edgeScrollQueued) return;
    edgeScrollQueued = true;
    const sequence = edgeScrollSequence;
    queueMicrotask(() => {
      edgeScrollQueued = false;
      if (destroyed || !followEditorEnd || sequence !== edgeScrollSequence) return;
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: "end", yMargin: 0 }) });
    });
  }
  function releaseEdgeScroll(): void {
    if (!edgeScrollActive) return;
    followEditorEnd = false;
    const sequence = ++edgeScrollSequence;
    queueMicrotask(() => {
      if (destroyed || sequence !== edgeScrollSequence) return;
      edgeScrollActive = false;
      view.dispatch({ effects: edgeScrollSlot.reconfigure([]) });
    });
  }

  async function importImages(files: File[], at: number | null): Promise<void> {
    await insertAsync(() => opts.onImages(files), at);
  }

  async function insertAsync(getText: () => Promise<string | null>, at: number | null = null): Promise<void> {
    if (view.state.readOnly || at === null && view.root.activeElement !== view.contentDOM) return;
    const selection = view.state.selection.main;
    const range = at === null ? { from: selection.from, to: selection.to } : { from: at, to: at };
    insertions.add(range);
    try {
      const text = await getText();
      if (!text || destroyed || view.state.readOnly) return;
      const source = view.state.field(editorText).text;
      const raw = { from: sourcePosition(view.state, range.from), to: sourcePosition(view.state, range.to) };
      const transaction = sourceTransaction(view.state, insertSource(source, raw, text));
      if (transaction) view.dispatch({ ...transaction, userEvent: "input.paste" });
      view.focus();
    } finally {
      insertions.delete(range);
    }
  }

  function configureVim(on: boolean): void {
    const seq = ++vimSeq;
    if (!on) {
      view.dispatch({ effects: vimSlot.reconfigure([]) });
      return;
    }
    void import("@replit/codemirror-vim").then(({ vim }) => {
      if (!destroyed && seq === vimSeq) view.dispatch({ effects: vimSlot.reconfigure(vim()) });
    });
  }
  if (vimOn) configureVim(true);
  view.dom.dataset.mode = mode;

  function inTable(): boolean {
    const position = view.state.selection.main.head;
    let node = syntaxTree(view.state).resolveInner(position, position === view.state.doc.length ? -1 : 1);
    while (node.parent && node.name !== "Table") node = node.parent;
    return node.name === "Table";
  }

  return {
    scroller: view.scrollDOM,
    async contextMenu(context, request) {
      const state = view.state;
      const pos = contextPosition;
      contextPosition = null;
      const word = context.misspelledWord;
      let range: { from: number; to: number } | undefined;
      if (pos !== null && word) {
        const line = state.doc.lineAt(pos);
        let from = line.text.indexOf(word);
        while (from >= 0) {
          if (line.from + from <= pos && line.from + from + word.length >= pos) {
            range = { from: line.from + from, to: line.from + from + word.length }; break;
          }
          from = line.text.indexOf(word, from + 1);
        }
      }
      const result = await request();
      if (!destroyed && view.state.doc === state.doc && range && result?.kind === "spelling") {
        const transaction = spellingReplacement(view.state, range, word, result.replacement);
        if (transaction) { view.dispatch(transaction); view.focus(); }
      }
    },
    snapshot() {
      return { scroll: view.scrollSnapshot(), state: retainEditorState(view.state) };
    },
    setChanges(changes) { view.dispatch({ effects: setChangeMarks.of(changes) }); },
    scrollToLine(line) { releaseEdgeScroll(); view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from, { y: "center" }) }); },
    getText: () => view.state.field(editorText).text,
    setText(text, addToHistory = false) {
      if (view.state.field(editorText).text === text) return;
      const next = parseByteText(text);
      const old = view.state.doc.toString();
      text = next.text;
      let start = 0;
      const max = Math.min(old.length, text.length);
      while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
      let endOld = old.length;
      let endNew = text.length;
      while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) {
        endOld--;
        endNew--;
      }
      silent = true;
      try {
        if (!addToHistory) view.dispatch({ effects: historySlot.reconfigure([]) });
        view.dispatch({
          changes: { from: start, to: endOld, insert: text.slice(start, endNew) },
          effects: restoreByteText.of(next.format),
          // Disk reloads reset history; task changes remain undoable.
          annotations: [Transaction.addToHistory.of(addToHistory), isolateHistory.of("full")],
        });
        if (!addToHistory) view.dispatch({ effects: historySlot.reconfigure(history()) });
      } finally {
        silent = false;
      }
      clearLiveCache();
    },
    setMdx(source, result) {
      view.dispatch({ effects: setMdxRanges.of(editorMdxRanges(source, result)) });
    },
    setEditable(editable) {
      view.dispatch({ effects: editableSlot.reconfigure([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]) });
    },
    setMode(next) {
      mode = next;
      view.dom.dataset.mode = next;
      view.dispatch({ effects: liveSlot.reconfigure(liveFor(next, view.state.doc.length)) });
      view.requestMeasure();
    },
    setVim(on) {
      vimOn = on;
      configureVim(on);
    },
    focus: () => view.focus(),
    refreshLayout: () => view.requestMeasure(),
    format(kind) {
      if (view.state.readOnly || view.root.activeElement !== view.contentDOM) return;
      const transaction = inlineTransaction(view.state, kind);
      if (transaction) view.dispatch(transaction);
    },
    block(command) {
      if (view.state.readOnly || view.root.activeElement !== view.contentDOM) return;
      const selection = sourceSelection(view.state);
      if (command === "footnote") selection.from = selection.to = sourcePosition(view.state, view.state.selection.main.head);
      const spec = sourceTransaction(view.state, blockEdit(view.state.field(editorText).text, selection, command, opts.isMdx?.() ?? /\.mdx$/i.test(opts.filename ?? "")));
      if (spec) { view.dispatch(spec); view.focus(); }
    },
    table(command) {
      if (view.state.readOnly || view.root.activeElement !== view.contentDOM || command !== "insert-table" && !inTable()) return;
      const head = sourcePosition(view.state, view.state.selection.main.head);
      const selection = command === "insert-table" ? sourceSelection(view.state) : { from: head, to: head };
      const spec = sourceTransaction(view.state, tableEdit(view.state.field(editorText).text, selection, command));
      if (spec) { view.dispatch(spec); view.focus(); }
    },
    inTable,
    fold(command) { releaseEdgeScroll(); runFold(view, command); view.focus(); },
    sourceSelection: () => sourceSelection(view.state),
    insertAsync,
    replace() { releaseEdgeScroll(); view.focus(); openSearchPanel(view); view.dom.querySelector<HTMLInputElement>('[name="replace"]')?.focus(); },
    goToLine() { releaseEdgeScroll(); gotoLine(view); },
    selection() { const range = view.state.selection.main; return view.state.sliceDoc(range.from, range.to); },
    find(text) {
      releaseEdgeScroll();
      if (text) view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: text, literal: true })) });
      view.focus();
      openSearchPanel(view);
    },
    findNext(backwards = false) { releaseEdgeScroll(); (backwards ? findPrevious : findNext)(view); },
    undo: () => { if (!view.state.readOnly) void undo(view); },
    redo: () => { if (!view.state.readOnly) void redo(view); },
    outlineItems(levels) {
      const headings: OutlineItem<number>[] = [];
      const blocks: OutlineItem<number>[] = [];
      const frontmatterEnd = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(view.state.doc.sliceString(0, 20_000))?.[0].length ?? 0;
      // Read the existing incremental tree. Unlike the command palette, the rail must never force parsing.
      syntaxTree(view.state).iterate({ enter(ref) {
        if (ref.name === "Document") return;
        if (ref.from < frontmatterEnd) return false;
        if (ref.node.parent?.name === "Document") blocks.push({ key: String(ref.from), text: `Section ${blocks.length + 1}`, level: 0, target: ref.from });
        const match = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(ref.name);
        if (!match) return /^(?:Blockquote|BulletList|OrderedList|ListItem)$/.test(ref.name) ? undefined : false;
        const line = view.state.doc.lineAt(ref.from);
        const text = line.text.replace(/^#{1,6}\s*/, "").replace(/\s#+\s*$/, "").trim();
        if (text) headings.push({ key: String(ref.from), text, level: Number(match[1]), target: ref.from });
        return false;
      } });
      return deriveOutline(headings, blocks, levels);
    },
    outlineOffset(pos) {
      return view.lineBlockAt(pos).top + view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
    },
    headings() {
      const found: Heading[] = [];
      // The closing --- of frontmatter makes the parser see a setext heading; it is not part of the outline.
      const frontmatterEnd = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(view.state.doc.sliceString(0, 20_000))?.[0].length ?? 0;
      const tree = ensureSyntaxTree(view.state, view.state.doc.length, 100);
      tree?.iterate({
        enter(ref) {
          const m = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(ref.name);
          if (!m) return;
          if (ref.from < frontmatterEnd) return false;
          const line = view.state.doc.lineAt(ref.from);
          const text = line.text.replace(/^#{1,6}\s*/, "").replace(/\s#+\s*$/, "").trim();
          if (text) found.push({ level: Number(m[1]), text, pos: line.from });
          return false;
        },
      });
      return found;
    },
    goTo(pos) {
      releaseEdgeScroll();
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }) });
      view.focus();
    },
    sourceAnchor() {
      const scroller = view.scrollDOM;
      if (scroller.scrollTop <= 1) return { kind: "start" };
      if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) return { kind: "end" };
      const top = scroller.getBoundingClientRect().top - view.documentTop;
      const block = view.lineBlockAtHeight(top);
      return { kind: "line", line: view.state.doc.lineAt(block.from).number - 1, offset: Math.max(0, Math.min(1, (top - block.top) / Math.max(1, block.height))) };
    },
    restoreAnchor(anchor) {
      const sequence = ++edgeScrollSequence;
      if (anchor.kind !== "line") {
        const kind = anchor.kind, position = kind === "start" ? 0 : view.state.doc.length;
        edgeScrollActive = true;
        followEditorEnd = kind === "end";
        // Scroll targets run after CodeMirror has measured the new viewport and
        // mounted its virtualized end. A measure-write runs too early after wrapping.
        const handler = EditorView.scrollHandler.of((current, range, target) => {
          if (sequence !== edgeScrollSequence || range.head !== position || target.y !== kind) return false;
          current.scrollDOM.scrollTop = kind === "start" ? 0 : current.scrollDOM.scrollHeight;
          if (kind === "start") releaseEdgeScroll();
          return true;
        });
        view.dispatch({ effects: [edgeScrollSlot.reconfigure(handler), EditorView.scrollIntoView(position, { y: kind, yMargin: 0 })] });
        return;
      }
      followEditorEnd = false;
      const pos = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, anchor.line + 1))).from;
      const effects = [EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 })];
      if (edgeScrollActive) { edgeScrollActive = false; effects.push(edgeScrollSlot.reconfigure([])); }
      view.dispatch({ effects });
      view.requestMeasure({
        read: () => {
          const block = view.lineBlockAt(pos);
          const base = view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
          return base + block.top + anchor.offset * block.height;
        },
        write: top => { view.scrollDOM.scrollTop = top; },
      });
    },
    scrollFraction() {
      const s = view.scrollDOM;
      const room = s.scrollHeight - s.clientHeight;
      return room > 0 ? s.scrollTop / room : 0;
    },
    destroy: () => {
      destroyed = true;
      edgeInputs.abort();
      cancelAnimationFrame(countFrame);
      ++vimSeq;
      view.destroy();
    },
  };
}

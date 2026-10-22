import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { bracketMatching, ensureSyntaxTree, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, keymap } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { type EditMode, LIVE_MAX_CHARS } from "../shared/types.js";
import { type LiveHost, clearLiveCache, frontmatterExtension, liveExtension } from "./live.js";
import { tableKeymap } from "./tables.js";

export type FormatKind = "bold" | "italic" | "code" | "strike" | "link";

export interface EditorOptions {
  text: string;
  mode: EditMode;
  host: LiveHost;
  /** Modal vim key bindings; applies in every edit mode. Default off. */
  vim?: boolean;
  onChange(text: string): void;
  onScroll(): void;
  onImages(files: File[]): Promise<string | null>;
}

export interface Heading {
  level: number;
  text: string;
  pos: number;
}

export interface EditorHandle {
  getText(): string;
  /** Replaces the document while keeping the cursor and scroll position near where they were. */
  setText(text: string, addToHistory?: boolean): void;
  setEditable(editable: boolean): void;
  setMode(mode: EditMode): void;
  setVim(on: boolean): void;
  focus(): void;
  format(kind: FormatKind): void;
  find(): void;
  undo(): void;
  redo(): void;
  headings(): Heading[];
  goTo(pos: number): void;
  scrollFraction(): number;
  scroller: HTMLElement;
  destroy(): void;
}

const MARKS: Record<Exclude<FormatKind, "link">, string> = { bold: "**", italic: "*", code: "`", strike: "~~" };

function toggleWrap(view: EditorView, mark: string): void {
  view.dispatch(
    view.state.changeByRange((range) => {
      const { state } = view;
      const len = mark.length;
      const text = state.sliceDoc(range.from, range.to);
      if (state.sliceDoc(range.from - len, range.from) === mark && state.sliceDoc(range.to, range.to + len) === mark) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len },
          ],
          range: EditorSelection.range(range.from - len, range.to - len),
        };
      }
      if (text.length >= len * 2 && text.startsWith(mark) && text.endsWith(mark)) {
        return {
          changes: [
            { from: range.from, to: range.from + len },
            { from: range.to - len, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - len * 2),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + len, range.to + len),
      };
    }),
  );
}

function insertLink(view: EditorView): void {
  view.dispatch(
    view.state.changeByRange((range) => {
      const label = view.state.sliceDoc(range.from, range.to);
      const insert = `[${label}](url)`;
      const urlFrom = range.from + label.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlFrom, urlFrom + 3),
      };
    }),
  );
}

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml|avif)$/;

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  const liveSlot = new Compartment();
  const historySlot = new Compartment();
  const vimSlot = new Compartment();
  const editableSlot = new Compartment();
  let mode = opts.mode;
  let vimOn = opts.vim ?? false;
  let silent = false;
  let destroyed = false;
  let vimSeq = 0;
  const insertions = new Set<{ from: number; to: number }>();

  const liveFor = (m: EditMode, length: number) => (m === "live" && length <= LIVE_MAX_CHARS ? liveExtension(opts.host) : []);

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.text,
      extensions: [
        historySlot.of(history()),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        EditorState.allowMultipleSelections.of(true),
        search({ top: true }),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(classHighlighter),
        frontmatterExtension,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Document", spellcheck: "true", autocapitalize: "sentences" }),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        tableKeymap,
        vimSlot.of([]),
        editableSlot.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
        liveSlot.of(liveFor(mode, opts.text.length)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) for (const range of insertions) {
            const empty = range.from === range.to;
            range.from = update.changes.mapPos(range.from, 1);
            range.to = Math.max(range.from, update.changes.mapPos(range.to, empty ? 1 : -1));
          }
          if (update.docChanged && !silent) opts.onChange(update.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          keydown(event) {
            // app.ts turns Escape in the edit view into "back to read mode", which
            // would yank vim out from under the user. Vim-handled Escapes arrive
            // already preventDefaulted (the app skips those); stop the rest here.
            if (vimOn && event.key === "Escape") event.stopPropagation();
            return false;
          },
          scroll: () => {
            opts.onScroll();
          },
          paste(event, v) {
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
            if (!sel.empty && /^https?:\/\/\S+$/.test(text)) {
              event.preventDefault();
              const label = v.state.sliceDoc(sel.from, sel.to);
              v.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${label}](${text})` }, userEvent: "input.paste" });
              return true;
            }
            return false;
          },
          drop(event, v) {
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

  async function importImages(files: File[], at: number | null): Promise<void> {
    const selection = view.state.selection.main;
    const range = at === null ? { from: selection.from, to: selection.to } : { from: at, to: at };
    insertions.add(range);
    try {
      const text = await opts.onImages(files);
      if (!text || destroyed || view.state.readOnly) return;
      view.dispatch({
        changes: { ...range, insert: text },
        selection: { anchor: range.from + text.length },
        scrollIntoView: true,
        userEvent: "input.paste",
      });
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

  return {
    scroller: view.scrollDOM,
    getText: () => view.state.doc.toString(),
    setText(text, addToHistory = false) {
      const old = view.state.doc.toString();
      if (old === text) return;
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
          // Disk reloads reset history; task changes remain undoable.
          annotations: [Transaction.addToHistory.of(addToHistory), isolateHistory.of("full")],
        });
        if (!addToHistory) view.dispatch({ effects: historySlot.reconfigure(history()) });
      } finally {
        silent = false;
      }
      clearLiveCache();
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
    format(kind) {
      view.focus();
      if (kind === "link") insertLink(view);
      else toggleWrap(view, MARKS[kind]);
    },
    find() {
      view.focus();
      openSearchPanel(view);
    },
    undo: () => void undo(view),
    redo: () => void redo(view),
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
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }) });
      view.focus();
    },
    scrollFraction() {
      const s = view.scrollDOM;
      const room = s.scrollHeight - s.clientHeight;
      return room > 0 ? s.scrollTop / room : 0;
    },
    destroy: () => {
      destroyed = true;
      ++vimSeq;
      view.destroy();
    },
  };
}

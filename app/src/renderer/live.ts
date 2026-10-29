import { getMdxRanges, isInMdxRange, setMdxRanges } from "./mdx-syntax.js";
import { type RenderedHtml } from "../shared/render-tree.js";
import { mountRenderedHtml, updateFragments } from "./author-html.js";
import { ensureSyntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { LIVE_MAX_CHARS } from "../shared/types.js";
import { destroyDiagrams, renderDiagrams } from "./diagrams.js";

/** Live Preview hides markdown syntax away from the cursor and renders heavy blocks in place. */
export interface LiveHost {
  renderFragment(text: string): Promise<RenderedHtml>;
  remoteImages?(): boolean;
  baseUrl(): string | null;
  openLink(href: string): void;
}


const disposed = new WeakSet<HTMLElement>();

const blockCache = new Map<string, { html: RenderedHtml; height: number }>();
const BLOCK_CACHE_LIMIT = 200;

export const clearLiveCache = () => blockCache.clear();

const mathOptions = { throwOnError: false, trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000 } as const;

class RenderedBlock extends WidgetType {
  constructor(
    readonly source: string,
    readonly kind: string,
    readonly host: LiveHost,
  ) {
    super();
  }

  eq(other: RenderedBlock): boolean {
    return other.kind === this.kind && other.source === this.source;
  }

  get estimatedHeight(): number {
    return blockCache.get(this.key())?.height ?? Math.max(48, this.source.split("\n").length * 26);
  }

  private key(): string {
    return `${this.host.baseUrl()}\0${this.kind}\0${this.source}`;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.kind === "image" ? "span" : "div");
    el.className = this.kind === "image" ? "cm-image" : `cm-rendered cm-rendered-${this.kind} prose`;
    const key = this.key();
    const show = (html: RenderedHtml) => {
      if (disposed.has(el)) return;
      destroyDiagrams(el);
      mountRenderedHtml(el, html, this.host.remoteImages?.() ?? true);
      updateFragments(el);
      if (this.kind === "image") {
        const image = el.querySelector("img");
        if (image?.getAttribute("src")) {
          image.className = "cm-image";
          image.loading = "lazy";
          image.addEventListener("load", () => view.requestMeasure());
          image.addEventListener("error", () => {
            el.textContent = image.alt || "Image not found";
            el.className = "cm-image-missing";
            view.requestMeasure();
          }, { once: true });
          el.replaceChildren(image);
        } else {
          el.textContent = image?.alt || "Image";
          el.className = "cm-image-missing";
        }
      }
      el.style.minHeight = "";
      void renderDiagrams(el).then(() => {
        if (disposed.has(el)) return;
        blockCache.set(key, { html, height: el.offsetHeight });
        view.requestMeasure();
      });
    };
    const cached = blockCache.get(key);
    if (cached) {
      show(cached.html);
    } else {
      el.style.minHeight = `${this.estimatedHeight}px`;
      void this.host.renderFragment(this.source).then((html) => {
        if (blockCache.size >= BLOCK_CACHE_LIMIT) blockCache.delete(blockCache.keys().next().value!);
        show(html);
      }).catch(() => {
        if (disposed.has(el)) return;
        el.textContent = this.source;
        el.style.minHeight = "";
        view.requestMeasure();
      });
    }
    el.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("a, button")) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }

  destroy(dom: HTMLElement): void {
    disposed.add(dom);
    destroyDiagrams(dom);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class AlertTitleWidget extends WidgetType {
  constructor(readonly kind: string) {
    super();
  }
  eq(other: AlertTitleWidget): boolean {
    return other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-alert-title";
    el.textContent = this.kind;
    return el;
  }
}

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = "•";
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly at: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.at === this.at;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "Completed task" : "Open task");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    return document.createElement("hr");
  }
}

class InlineMathWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }
  eq(other: InlineMathWidget): boolean {
    return other.tex === this.tex;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-math-inline";
    el.textContent = `$${this.tex}$`;
    void import("katex").then(({ default: katex }) => {
      if (!el.isConnected) return;
      el.innerHTML = katex.renderToString(this.tex, { ...mathOptions, displayMode: false });
      view.requestMeasure();
    }).catch(() => {});
    return el;
  }
}

const hide = Decoration.replace({});
const lineDeco = (cls: string, attrs?: Record<string, string>) => Decoration.line({ class: cls, attributes: attrs });

const INLINE_MATH = /(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$\w])/g;

function frontmatterEnd(doc: string): number {
  const m = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(doc);
  return m ? m[0].length : 0;
}

function build(state: EditorState, host: LiveHost): DecorationSet {
  const doc = state.doc;
  if (doc.length > LIVE_MAX_CHARS) return Decoration.none;
  const tree = ensureSyntaxTree(state, doc.length, 80);
  if (!tree) return Decoration.none;

  const out: Range<Decoration>[] = [];
  const sel = state.selection.ranges;
  const touches = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const lineTouches = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const baseUrl = host.baseUrl();
  const fmEnd = frontmatterEnd(doc.sliceString(0, 4000));
  const blocked: Array<[number, number]> = getMdxRanges(state).map((range) => [range.start, range.end]); // ranges where inline scanning must not run

  const linesOf = (from: number, to: number, cb: (lineFrom: number, index: number) => void) => {
    const last = doc.lineAt(to).number;
    for (let n = doc.lineAt(from).number, i = 0; n <= last; n++, i++) cb(doc.line(n).from, i);
  };

  if (fmEnd) blocked.push([0, fmEnd]);

  const block = (from: number, to: number, kind: string, source: string) => {
    blocked.push([from, to]);
    out.push(Decoration.replace({ widget: new RenderedBlock(source, kind, host), block: true }).range(from, to));
  };

  tree.iterate({
    enter(ref) {
      const { name, from, to } = ref;
      if (name === "Document") return;
      if (from < fmEnd || isInMdxRange(state, from)) return false;
      // A parent Markdown node may span JSX. Never replace any part of that node.
      if (blocked.some(([a, b]) => a < to && b > from)) return;
      const node = ref.node;

      switch (name) {
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6":
          out.push(lineDeco(`cm-heading cm-h${name.at(-1)}`).range(doc.lineAt(from).from));
          return;
        case "SetextHeading1":
        case "SetextHeading2":
          linesOf(from, to, (lf, i) => out.push(lineDeco(i === 0 ? `cm-heading cm-h${name.at(-1)}` : "cm-setext-rule").range(lf)));
          return;
        case "HeaderMark": {
          if (node.parent?.name.startsWith("ATX") && !lineTouches(from, to)) {
            const lineEnd = doc.lineAt(from).to;
            out.push(hide.range(from, Math.min(to + 1, lineEnd)));
          }
          return;
        }
        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough":
        case "InlineCode": {
          const cls = { Emphasis: "cm-em", StrongEmphasis: "cm-strong", Strikethrough: "cm-strike", InlineCode: "cm-inline-code" }[name]!;
          out.push(Decoration.mark({ class: cls }).range(from, to));
          return;
        }
        case "EmphasisMark":
        case "StrikethroughMark":
        case "CodeMark": {
          const p = node.parent;
          if (p && p.name !== "FencedCode" && !touches(p.from, p.to)) out.push(hide.range(from, to));
          return;
        }
        case "Link": {
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          if (marks.length < 4 || !url) return;
          const open = marks[0]!;
          const close = marks[1]!;
          const rawHref = doc.sliceString(url.from, url.to);
          const href = rawHref.startsWith("<") && rawHref.endsWith(">") ? rawHref.slice(1, -1) : rawHref;
          if (touches(from, to)) {
            out.push(Decoration.mark({ class: "cm-link-source" }).range(from, to));
            return;
          }
          out.push(hide.range(open.from, open.to));
          out.push(Decoration.mark({ class: "cm-link", attributes: { "data-href": href, title: href } }).range(open.to, close.from));
          out.push(hide.range(close.from, to));
          return false;
        }
        case "Image": {
          if (touches(from, to)) return;
          out.push(Decoration.replace({ widget: new RenderedBlock(doc.sliceString(from, to), "image", host) }).range(from, to));
          return false;
        }
        case "Blockquote": {
          const first = doc.sliceString(from, Math.min(to, from + 40));
          const alert = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(first)?.[1]?.toLowerCase();
          linesOf(from, to, (lf) => out.push(lineDeco(alert ? `cm-quote cm-alert cm-alert-${alert}` : "cm-quote").range(lf)));
          if (alert) {
            const line = doc.lineAt(from);
            const at = line.text.search(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
            if (at >= 0 && !touches(line.from, line.to)) {
              out.push(Decoration.replace({ widget: new AlertTitleWidget(alert) }).range(line.from + at, line.from + at + alert.length + 3));
            }
          }
          return;
        }
        case "QuoteMark": {
          if (!lineTouches(from, to)) {
            const next = doc.sliceString(to, to + 1);
            out.push(hide.range(from, next === " " ? to + 1 : to));
          }
          return;
        }
        case "ListItem": {
          const nested = node.getChild("BulletList") ?? node.getChild("OrderedList");
          const end = nested ? Math.max(from, nested.from - 1) : to;
          const mark = node.getChild("ListMark");
          const indent = mark ? mark.to - doc.lineAt(from).from + 1 : 2;
          linesOf(from, end, (lf) => out.push(lineDeco("cm-li", { style: `--li-indent:${indent}` }).range(lf)));
          return;
        }
        case "ListMark": {
          const item = node.parent;
          const bullet = item?.parent?.name === "BulletList";
          if (!bullet || lineTouches(from, to)) return;
          const isTask = Boolean(item?.getChild("Task"));
          out.push(isTask ? hide.range(from, to + 1) : Decoration.replace({ widget: new BulletWidget() }).range(from, to));
          return;
        }
        case "TaskMarker": {
          if (lineTouches(from, to)) return;
          const checked = /x/i.test(doc.sliceString(from, to));
          out.push(Decoration.replace({ widget: new CheckboxWidget(checked, from) }).range(from, to));
          return;
        }
        case "HorizontalRule": {
          if (!lineTouches(from, to)) out.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
          return;
        }
        case "FencedCode": {
          if (!touches(from, to)) {
            block(from, to, "fence", doc.sliceString(from, to));
          } else {
            blocked.push([from, to]);
            const last = doc.lineAt(to).number;
            linesOf(from, to, (lf, i) => {
              const n = doc.lineAt(lf).number;
              out.push(lineDeco(`cm-codeblock${i === 0 ? " cm-codeblock-first" : ""}${n === last ? " cm-codeblock-last" : ""}`).range(lf));
            });
          }
          return false;
        }
        case "Table": {
          if (!touches(from, to)) {
            block(from, to, "table", doc.sliceString(from, to));
          } else {
            blocked.push([from, to]);
            linesOf(from, to, (lf) => out.push(lineDeco("cm-table-source").range(lf)));
          }
          return false;
        }
        case "HTMLBlock":
        case "CommentBlock": {
          linesOf(from, to, (lf) => out.push(lineDeco("cm-html").range(lf)));
          blocked.push([from, to]);
          return false;
        }
        default:
          return;
      }
    },
  });

  // `$$ … $$` display math is not part of the markdown grammar, so find it by line.
  const inBlocked = (pos: number) => blocked.some(([a, b]) => pos >= a && pos < b);
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (inBlocked(line.from) || !line.text.trimStart().startsWith("$$")) continue;
    const trimmed = line.text.trim();
    let endLine = line;
    if (!(trimmed.length > 3 && trimmed.endsWith("$$"))) {
      let m = n + 1;
      while (m <= doc.lines && !doc.line(m).text.trimEnd().endsWith("$$")) m++;
      if (m > doc.lines) continue;
      endLine = doc.line(m);
      n = m;
    }
    if (blocked.some(([a, b]) => a < endLine.to && b > line.from)) continue;
    if (touches(line.from, endLine.to)) {
      linesOf(line.from, endLine.to, (lf) => out.push(lineDeco("cm-math-source").range(lf)));
      blocked.push([line.from, endLine.to]);
    } else {
      block(line.from, endLine.to, "math", doc.sliceString(line.from, endLine.to));
    }
  }

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!line.text.includes("$") || inBlocked(line.from)) continue;
    INLINE_MATH.lastIndex = 0;
    for (let m = INLINE_MATH.exec(line.text); m; m = INLINE_MATH.exec(line.text)) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (touches(from, to) || isInMdxRange(state, from) || blocked.some(([a, b]) => a < to && b > from)) continue;
      const inner = tree.resolveInner(from, 1);
      if (inner.name === "InlineCode" || inner.name === "CodeText" || inner.name === "URL") continue;
      out.push(Decoration.replace({ widget: new InlineMathWidget(m[1]!) }).range(from, to));
    }
  }

  return Decoration.set(out, true);
}

/** Frontmatter is not markdown, so mute it in every mode instead of letting the parser read it as a heading. */
export const frontmatterExtension = StateField.define<DecorationSet>({
  create: (state) => frontmatterDecorations(state),
  update: (deco, tr) => (tr.docChanged ? frontmatterDecorations(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

function frontmatterDecorations(state: EditorState): DecorationSet {
  const end = frontmatterEnd(state.doc.sliceString(0, 4000));
  if (!end) return Decoration.none;
  const lines: Range<Decoration>[] = [];
  const last = state.doc.lineAt(Math.max(0, end - 1)).number;
  for (let n = 1; n <= last; n++) lines.push(lineDeco("cm-frontmatter").range(state.doc.line(n).from));
  return Decoration.set(lines);
}

export function liveExtension(host: LiveHost): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, host),
    update(deco, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((effect) => effect.is(setMdxRanges)) || tr.state.facet(EditorView.editable) !== tr.startState.facet(EditorView.editable)) {
        return build(tr.state, host);
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const linkClicks = EditorView.domEventHandlers({
    click(event) {
      const link = (event.target as HTMLElement).closest<HTMLElement>(".cm-link");
      const href = link?.dataset.href;
      if (!href) return false;
      // Plain clicks place the cursor, which reveals the markup for editing.
      if (!(event.metaKey || event.ctrlKey)) return false;
      event.preventDefault();
      host.openLink(href);
      return true;
    },
  });

  return [field, linkClicks];
}

export type { SyntaxNode };

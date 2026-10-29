import { getMdxRanges, isInMdxRange, setMdxRanges } from "./mdx-syntax.js";
import { type RenderedHtml } from "../shared/render-tree.js";
import { mountRenderedHtml, updateFragments } from "./author-html.js";
import { syntaxTree } from "@codemirror/language";
import { displayMath, expandRegion, liveTree, mapRegion, mathLines, mergeRegions, type Region } from "./live-regions.js";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
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
      if (blockCache.size >= BLOCK_CACHE_LIMIT && !blockCache.has(key)) blockCache.delete(blockCache.keys().next().value!);
      blockCache.set(key, { html, height: blockCache.get(key)?.height ?? this.estimatedHeight });
      view.requestMeasure();
      void renderDiagrams(el).then(() => {
        if (disposed.has(el)) return;
        view.requestMeasure({ key: el,
          read: () => disposed.has(el) ? null : el.offsetHeight,
          write: height => {
            if (height === null || disposed.has(el)) return;
            if (blockCache.size >= BLOCK_CACHE_LIMIT && !blockCache.has(key)) blockCache.delete(blockCache.keys().next().value!);
            blockCache.set(key, { html, height });
          },
        });
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
  ) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
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
      const at = view.posAtDOM(box);
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: this.checked ? " " : "x" } });
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

export function buildLiveDecorations(state: EditorState, host: LiveHost, region?: Region, math?: readonly Region[]): DecorationSet {
  const doc = state.doc;
  if (doc.length > LIVE_MAX_CHARS) return Decoration.none;
  const tree = liveTree(state);
  if (!tree) return Decoration.none;

  const scope = region ?? { from: 0, to: doc.length };
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
    from: scope.from, to: scope.to,
    enter(ref) {
      const { name, from, to } = ref;
      if (name === "Document") return;
      if (to <= scope.from || from > scope.to) return false;
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
          out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to));
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

  const inBlocked = (pos: number) => blocked.some(([a, b]) => pos >= a && pos < b);
  for (const range of math ?? displayMath(state, tree, mathLines(state), fmEnd)) {
    if (range.to < scope.from || range.from > scope.to) continue;
    if (touches(range.from, range.to)) {
      linesOf(range.from, range.to, (lf) => out.push(lineDeco("cm-math-source").range(lf)));
      blocked.push([range.from, range.to]);
    } else block(range.from, range.to, "math", doc.sliceString(range.from, range.to));
  }

  for (let n = doc.lineAt(scope.from).number; n <= doc.lineAt(scope.to).number; n++) {
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

export const setLiveViewport = StateEffect.define<Region>();

export function liveDecorationField(host: LiveHost) {
  return StateField.define({
    create(state) {
      const tree = liveTree(state);
      const markers = mathLines(state);
      const math = tree ? displayMath(state, tree, markers, frontmatterEnd(state.doc.sliceString(0, 4000))) : [];
      const viewport = { from: 0, to: state.doc.length };
      return { decorations: buildLiveDecorations(state, host, undefined, math), tree, markers, math, viewport };
    },
    update(value, tr) {
      const viewportEffect = tr.effects.find(e => e.is(setLiveViewport));
      const viewport = viewportEffect?.value ?? mapRegion(value.viewport, tr.changes);
      const mdxChanged = tr.effects.some(e => e.is(setMdxRanges));
      const tree = tr.docChanged || viewportEffect || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? liveTree(tr.state) : value.tree;
      if (!tree || tr.state.doc.length > LIVE_MAX_CHARS) return { ...value, decorations: Decoration.none, tree, viewport };
      const markers = tr.docChanged ? mathLines(tr.state, value.markers, tr) : value.markers;
      const fmEnd = frontmatterEnd(tr.state.doc.sliceString(0, 4000));
      const math = tr.docChanged || mdxChanged || tree !== value.tree ? displayMath(tr.state, tree, markers, fmEnd) : value.math;
      const scope = expandRegion(tr.state, tree, viewport, math);
      const full = viewportEffect || mdxChanged || !value.tree || (!tr.docChanged && tree !== value.tree);
      const dirty: Region[] = [];
      const add = (region: Region) => {
        const expanded = expandRegion(tr.state, tree, region, math);
        if (expanded.to >= scope.from && expanded.from <= scope.to) dirty.push(expanded);
      };
      if (full) add(viewport);
      else {
        tr.changes.iterChangedRanges((a, b, c, d) => {
          // Include adjacent lines for setext headings and joining/splitting blocks.
          const oldDoc = tr.startState.doc, doc = tr.state.doc;
          const oldRange = expandRegion(tr.startState, value.tree!, {
            from: oldDoc.line(Math.max(1, oldDoc.lineAt(a).number - 1)).from,
            to: oldDoc.line(Math.min(oldDoc.lines, oldDoc.lineAt(b).number + 1)).to,
          }, value.math);
          let region = { from: Math.min(tr.changes.mapPos(oldRange.from, -1), doc.line(Math.max(1, doc.lineAt(c).number - 1)).from),
            to: Math.max(tr.changes.mapPos(oldRange.to, 1), doc.line(Math.min(doc.lines, doc.lineAt(d).number + 1)).to) };
          const inverse = tr.changes.invertedDesc;
          for (;;) {
            const next = expandRegion(tr.state, tree, region, math);
            const old = expandRegion(tr.startState, value.tree!, mapRegion(next, inverse), value.math);
            const mapped = mapRegion(old, tr.changes);
            const expanded = { from: Math.min(next.from, mapped.from), to: Math.max(next.to, mapped.to) };
            if (expanded.from === region.from && expanded.to === region.to) break;
            region = expanded;
          }
          add(region);
        });
        if (tr.docChanged && fmEnd !== tr.changes.mapPos(frontmatterEnd(tr.startState.doc.sliceString(0, 4000)), 1)) {
          add({ from: 0, to: Math.max(fmEnd, tr.changes.mapPos(frontmatterEnd(tr.startState.doc.sliceString(0, 4000)), 1)) });
        }
        if (tr.docChanged) {
          const oldMath = value.math.map(r => mapRegion(r, tr.changes));
          for (const r of oldMath) if (!math.some(m => m.from === r.from && m.to === r.to)) add(r);
          for (const r of math) if (!oldMath.some(m => m.from === r.from && m.to === r.to)) add(r);
        }
        if (tr.selection || tr.docChanged) {
          for (const r of tr.startState.selection.ranges) add(mapRegion(r, tr.changes));
          for (const r of tr.state.selection.ranges) add(r);
        }
      }
      const previousScope = value.tree ? mapRegion(expandRegion(tr.startState, value.tree, value.viewport, value.math), tr.changes) : scope;
      if (scope.from < previousScope.from) add({ from: scope.from, to: previousScope.from });
      if (scope.to > previousScope.to) add({ from: previousScope.to, to: scope.to });
      let decorations = full ? Decoration.none : value.decorations.map(tr.changes);
      // A changed fence can split a previous replacement. Invalidate that entire
      // replacement before filtering it, then expand against the new syntax tree.
      for (let i = 0; i < dirty.length; i++) {
        let region = dirty[i]!;
        for (;;) {
          let from = region.from, to = region.to;
          decorations.between(from, to, (a, b) => { from = Math.min(from, a); to = Math.max(to, b); });
          const expanded = expandRegion(tr.state, tree, { from, to }, math);
          if (expanded.from === region.from && expanded.to === region.to) break;
          region = expanded;
        }
        dirty[i] = region;
      }
      for (const region of mergeRegions(dirty)) {
        const replacement = buildLiveDecorations(tr.state, host, region, math);
        const add: Range<Decoration>[] = [];
        for (let cursor = replacement.iter(); cursor.value; cursor.next()) add.push(cursor.value.range(cursor.from, cursor.to));
        decorations = decorations.update({ filterFrom: region.from, filterTo: region.to,
          filter: (from, to) => to < region.from || from > region.to, add, sort: true });
      }
      decorations = decorations.update({ filter: (from, to) => from >= scope.from && to <= scope.to });
      return { decorations, tree, markers, math, viewport };
    },
    provide: f => EditorView.decorations.from(f, value => value.decorations),
  });
}

export function liveExtension(host: LiveHost): Extension {
  const field = liveDecorationField(host);
  // Block replacements must come from a state field. Publish the measured viewport
  // after CodeMirror's update, never dispatch recursively from a view update.
  const viewport = ViewPlugin.fromClass(class {
    frame = 0;
    constructor(readonly view: EditorView) { this.schedule(); }
    update(update: import("@codemirror/view").ViewUpdate) {
      if (update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.schedule();
    }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const { from, to } = this.view.viewport;
        const current = this.view.state.field(field).viewport;
        if (from !== current.from || to !== current.to || syntaxTree(this.view.state) !== this.view.state.field(field).tree) {
          this.view.dispatch({ effects: setLiveViewport.of({ from, to }) });
        }
      });
    }
    destroy() { cancelAnimationFrame(this.frame); }
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

  return [field, viewport, linkClicks];
}

export type { SyntaxNode };

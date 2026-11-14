import { codeFolding, foldEffect, unfoldEffect, foldedRanges, foldable, foldService, syntaxTree, unfoldCode, unfoldAll, ensureSyntaxTree } from "@codemirror/language";
import { type EditorState, type Range, RangeSet, RangeValue, StateEffect, StateField } from "@codemirror/state";
import { gutter, GutterMarker, ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

class Delimiter extends RangeValue {}
const delimiter = new Delimiter();
function delimiters(state: EditorState, from: number, to: number) {
  const found = [];
  const first = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number;
  for (let i = first; i <= last; i++) {
    const line = state.doc.line(i);
    if (line.length === 3 && (line.text === "---" || line.text === "...")) found.push(delimiter.range(line.from));
  }
  return found;
}
function frontmatter(state: EditorState, markers: RangeSet<Delimiter>): { from: number; to: number } | null {
  const first = state.doc.line(1);
  if (first.text !== "---") return null;
  const next = markers.iter(first.to + 1);
  return next.value ? { from: first.to, to: state.doc.lineAt(next.from).to } : null;
}
// Index delimiters once, then update only changed lines. Typing never scans the document.
const frontmatterFold = StateField.define({
  create(state) {
    const markers = RangeSet.of(delimiters(state, 0, state.doc.length));
    return { markers, range: frontmatter(state, markers) };
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    let markers = value.markers.map(tr.changes);
    tr.changes.iterChangedRanges((_a, _b, from, to) => {
      const start = tr.state.doc.lineAt(from).from, end = tr.state.doc.lineAt(to).to;
      markers = markers.update({ filterFrom: start, filterTo: end, filter: (at) => at < start || at > end, add: delimiters(tr.state, start, end), sort: true });
    });
    return { markers, range: frontmatter(tr.state, markers) };
  },
});
class FoldMarker extends GutterMarker {
  constructor(readonly closed: boolean) { super(); }
  eq(other: FoldMarker): boolean { return this.closed === other.closed; }
  toDOM(): HTMLElement {
    const mark = document.createElement("span");
    mark.textContent = this.closed ? "›" : "⌄";
    mark.title = this.closed ? "Unfold" : "Fold";
    mark.style.cssText = "display:inline-block;width:1ch";
    return mark;
  }
}
const openMarker = new FoldMarker(false), closedMarker = new FoldMarker(true);
const setFoldIndex = StateEffect.define<RangeSet<FoldMarker>>();
const foldIndex = StateField.define<RangeSet<FoldMarker>>({
  create: () => RangeSet.of<FoldMarker>([]),
  update(value, tr) {
    return tr.effects.find(effect => effect.is(setFoldIndex))?.value ?? (tr.docChanged ? value.map(tr.changes) : value);
  },
});
// A gutter lookup must not walk a heading's siblings on every key. Build its
// point index in bounded idle slices; edits only map the previous index.
const foldIndexer = ViewPlugin.fromClass(class {
  timer = 0;
  idle = 0;
  generation = 0;
  constructor(readonly view: EditorView) { this.schedule(0); }
  update(update: ViewUpdate) {
    if (update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.schedule(160);
  }
  schedule(delay: number) {
    this.cancel();
    const generation = this.generation;
    this.timer = window.setTimeout(() => {
      const state = this.view.state, tree = syntaxTree(state), cursor = tree.cursor();
      const fm = state.field(frontmatterFold).range;
      const markers: Range<FoldMarker>[] = [];
      let more = true;
      const step = (deadline: IdleDeadline) => {
        if (generation !== this.generation || state.doc !== this.view.state.doc || tree !== syntaxTree(this.view.state)) return;
        let visited = 0;
        const until = performance.now() + 2;
        while (more && (visited < 32 || performance.now() < until && deadline.timeRemaining() > 1)) {
          const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(cursor.name);
          if ((!fm || cursor.from > fm.to) && (heading || cursor.name === "FencedCode")) {
            const line = state.doc.lineAt(cursor.from), next = cursor.node.nextSibling;
            const nextHeading = next && /^(?:ATX|Setext)Heading(\d)$/.exec(next.name);
            if (cursor.to > line.to || heading && next && (!nextHeading || Number(nextHeading[1]) > Number(heading[1]))) markers.push(openMarker.range(line.from));
          }
          more = cursor.next(); visited++;
        }
        if (more) this.idle = window.requestIdleCallback(step, { timeout: 500 });
        else this.view.dispatch({ effects: setFoldIndex.of(RangeSet.of(markers, true)) });
      };
      this.idle = window.requestIdleCallback(step, { timeout: 500 });
    }, delay);
  }
  cancel() { this.generation++; window.clearTimeout(this.timer); window.cancelIdleCallback(this.idle); }
  destroy() { this.cancel(); }
});
const writingFoldGutter = gutter({
  class: "cm-foldGutter",
  initialSpacer: () => openMarker,
  lineMarker(view, line) {
    let folded = false, available = line.from === 0 && !!view.state.field(frontmatterFold).range;
    foldedRanges(view.state).between(line.from, line.to, () => { folded = true; });
    view.state.field(foldIndex).between(line.from, line.to, () => { available = true; });
    return folded ? closedMarker : available ? openMarker : null;
  },
  lineMarkerChange: update => foldedRanges(update.startState) !== foldedRanges(update.state) || update.transactions.some(tr => tr.effects.some(effect => effect.is(setFoldIndex))),
  domEventHandlers: { click(view, line) {
    let folded: { from: number; to: number } | undefined;
    foldedRanges(view.state).between(line.from, line.to, (from, to) => { folded ??= { from, to }; });
    if (folded) { view.dispatch({ effects: unfoldEffect.of(folded) }); return true; }
    ensureSyntaxTree(view.state, view.state.doc.length, 100);
    const range = foldable(view.state, line.from, view.state.doc.lineAt(line.from).to);
    if (!range) return false;
    view.dispatch({ effects: foldEffect.of(range) }); return true;
  } },
});
export const writingFolding = [
  frontmatterFold,
  foldService.of((state, start) => start === 0 ? state.field(frontmatterFold).range : null),
  codeFolding(), foldIndex, foldIndexer, writingFoldGutter,
];
export type FoldCommand = "fold" | "unfold" | "fold-all" | "unfold-all";
export function runFold(view: EditorView, command: FoldCommand): void {
  if (command === "unfold-all") { unfoldAll(view); return; }
  ensureSyntaxTree(view.state, view.state.doc.length, 100);
  if (command === "fold-all") {
    const effects = [];
    const fm = view.state.field(frontmatterFold).range;
    if (fm) effects.push(foldEffect.of(fm));
    const headings: { from: number; to: number; level: number }[] = [];
    syntaxTree(view.state).iterate({ enter(node) {
      const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
      if (match && (!fm || node.from > fm.to)) headings.push({ from: node.from, to: node.to, level: Number(match[1]) });
    } });
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]!;
      let end = view.state.doc.length;
      for (let next = i + 1; next < headings.length; next++) if (headings[next]!.level <= heading.level) { end = headings[next]!.from; break; }
      const from = view.state.doc.lineAt(heading.to).to;
      const to = end < view.state.doc.length ? Math.max(from, end - 1) : end;
      if (to > from) effects.push(foldEffect.of({ from, to }));
    }
    view.dispatch({ effects }); return;
  }
  const head = view.state.selection.main.head;
  const fm = view.state.field(frontmatterFold).range;
  let node = syntaxTree(view.state).resolveInner(head, head === view.state.doc.length ? -1 : 1);
  while (node.parent && !/^(?:FencedCode|ATXHeading\d|SetextHeading\d)$/.test(node.name)) node = node.parent;
  if (command === "unfold") {
    // unfoldCode expects the cursor on the opening line; folded selections normally sit there.
    unfoldCode(view); return;
  }
  if (fm && head <= fm.to) { view.dispatch({ effects: foldEffect.of(fm), selection: { anchor: fm.from } }); return; }
  if (/^FencedCode$/.test(node.name)) {
    const from = view.state.doc.lineAt(node.from).to;
    view.dispatch({ effects: foldEffect.of({ from, to: node.to }), selection: { anchor: from } }); return;
  }
  const headings: { from: number; to: number; level: number }[] = [];
  syntaxTree(view.state).iterate({ enter(item) {
    const match = /^(?:ATX|Setext)Heading(\d)$/.exec(item.name);
    if (match && (!fm || item.from > fm.to)) headings.push({ from: item.from, to: item.to, level: Number(match[1]) });
  } });
  const heading = headings.filter(item => item.from <= head).at(-1);
  if (heading) {
    const from = view.state.doc.lineAt(heading.to).to;
    const next = headings.find(item => item.from > heading.from && item.level <= heading.level)?.from;
    const to = next === undefined ? view.state.doc.length : next - 1;
    if (to > from) view.dispatch({ effects: foldEffect.of({ from, to }), selection: { anchor: from } });
  }
}

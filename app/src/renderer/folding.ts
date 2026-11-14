import { codeFolding, foldEffect, foldGutter, foldService, syntaxTree, unfoldCode, unfoldAll, ensureSyntaxTree } from "@codemirror/language";
import { type EditorState, RangeSet, RangeValue, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

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
export const writingFolding = [
  frontmatterFold,
  foldService.of((state, start) => start === 0 ? state.field(frontmatterFold).range : null),
  codeFolding(),
  foldGutter({ openText: "⌄", closedText: "›" }),
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
      const end = headings.slice(i + 1).find(next => next.level <= heading.level)?.from ?? view.state.doc.length;
      const from = view.state.doc.lineAt(heading.to).to;
      const to = end < view.state.doc.length ? Math.max(from, end - 1) : end;
      if (to > from) effects.push(foldEffect.of({ from, to }));
    }
    view.dispatch({ effects }); return;
  }
  const head = view.state.selection.main.head;
  const fm = view.state.field(frontmatterFold).range;
  let node = syntaxTree(view.state).resolveInner(head, -1);
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

import { codeFolding, foldEffect, syntaxTree, unfoldCode, unfoldAll, ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

function frontmatter(state: EditorState): { from: number; to: number } | null {
  if (state.doc.line(1).text !== "---") return null;
  for (let i = 2; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (line.text === "---" || line.text === "...") return { from: state.doc.line(1).to, to: line.to };
  }
  return null;
}
export const writingFolding = codeFolding();
export type FoldCommand = "fold" | "unfold" | "fold-all" | "unfold-all";
export function runFold(view: EditorView, command: FoldCommand): void {
  if (view.state.readOnly) return;
  if (command === "unfold-all") { unfoldAll(view); return; }
  ensureSyntaxTree(view.state, view.state.doc.length, 100);
  if (command === "fold-all") {
    const effects = [];
    const fm = frontmatter(view.state);
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
  const fm = frontmatter(view.state);
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

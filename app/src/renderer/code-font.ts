import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

function codeFonts(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const lines = new Set<number>();
  for (const visible of view.visibleRanges) syntaxTree(view.state).iterate({
    from: visible.from, to: visible.to,
    enter(node) {
      if (node.name === "InlineCode") {
        ranges.push(Decoration.mark({ class: "cm-code-font-inline" }).range(node.from, node.to));
        return false;
      }
      if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
      const first = view.state.doc.lineAt(Math.max(visible.from, node.from)).number;
      const last = view.state.doc.lineAt(Math.min(visible.to, node.to)).number;
      for (let n = first; n <= last; n++) lines.add(view.state.doc.line(n).from);
      return false;
    },
  });
  for (const line of lines) ranges.push(Decoration.line({ class: "cm-code-font" }).range(line));
  return Decoration.set(ranges, true);
}

export const codeFont = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = codeFonts(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = codeFonts(update.view);
  }
}, { decorations: plugin => plugin.decorations });

import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { getMdxRanges } from "./mdx-syntax.js";

/** URL wrapping is a prose edit, never an edit to code or metadata. */
export function canPasteLink(state: EditorState): boolean {
  const { from, to, empty } = state.selection.main;
  if (empty || state.readOnly) return false;
  const frontmatter = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(state.doc.toString());
  if (frontmatter && from < frontmatter[0].length) return false;
  if (getMdxRanges(state).some(range => range.start < to && range.end > from)) return false;
  const tree = ensureSyntaxTree(state, to, 50);
  if (!tree) return false;
  let plain = true;
  tree.iterate({ from, to, enter(node) {
    if (node.from > from || /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i.test(node.name)) plain = false;
  }, leave(node) { if (node.to < to) plain = false; } });
  return plain;
}

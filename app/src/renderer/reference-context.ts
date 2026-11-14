import type { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { getMdxRanges } from "./mdx-syntax.js";

const contexts = new WeakMap<Tree, { doc: EditorState["doc"]; mdx: ReturnType<typeof getMdxRanges> | null; text: string }>();

/** Reuse Markdown's definition boundaries, including multiline destinations/titles. */
export function referenceContext(state: EditorState, tree: Tree): string {
  const ranges = getMdxRanges(state);
  const mdx = ranges.length ? ranges : null;
  const cached = contexts.get(tree);
  if (cached?.doc === state.doc && cached.mdx === mdx) return cached.text;
  const definitions: string[] = [];
  const frontmatter = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(state.doc.sliceString(0, 4000))?.[0].length ?? 0;
  tree.iterate({ enter(node) {
    if (node.name !== "LinkReference") return;
    if (node.from >= frontmatter && !ranges.some(range => range.start < node.to && range.end > node.from)) definitions.push(state.sliceDoc(node.from, node.to));
    return false;
  } });
  const text = definitions.join("\n\n");
  contexts.set(tree, { doc: state.doc, mdx, text });
  return text;
}

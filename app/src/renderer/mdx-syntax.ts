import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { MdxRange, MdxSpan } from "../shared/mdx-ranges.js";

/** Dispatch parsed ranges for the current document, after checking its revision. */
export const setMdxRanges = StateEffect.define<readonly MdxRange[]>();

interface MdxSyntaxState {
  ranges: readonly MdxRange[];
  decorations: DecorationSet;
  protected: { start: number; end: number }[];
}

function syntaxState(ranges: readonly MdxRange[], mapped?: DecorationSet): MdxSyntaxState {
  const marks = mapped ?? Decoration.set(ranges.flatMap((range) => range.syntax.map((span) =>
    Decoration.mark({ class: `cm-mdx-${span.kind}`, inclusive: true }).range(span.start, span.end),
  )), true);
  const protectedRanges: MdxSyntaxState["protected"] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = protectedRanges.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else protectedRanges.push({ start: range.start, end: range.end });
  }
  return { ranges, decorations: marks, protected: protectedRanges };
}

export const mdxRangesField = StateField.define<MdxSyntaxState>({
  create: () => syntaxState([]),
  update(value, transaction) {
    const replacement = transaction.effects.findLast((effect) => effect.is(setMdxRanges));
    if (replacement) return syntaxState(replacement.value);
    if (!transaction.docChanged) return value;
    const { changes, newDoc } = transaction;
    function mapSpan<T extends MdxSpan>(span: T): T {
      const start = changes.mapPos(span.start, -1);
      const end = changes.mapPos(span.end, 1);
      return { ...span, start, end, startLine: newDoc.lineAt(start).number, endLine: newDoc.lineAt(Math.max(start, end - 1)).number };
    }
    const ranges = value.ranges.map((range) => ({
      ...mapSpan(range),
      syntax: range.syntax.map(mapSpan).filter((span) => span.start < span.end),
    })).filter((range) => range.start < range.end);
    return syntaxState(ranges, value.decorations.map(changes));
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Highlight marks only. This extension never replaces, folds, or edits text. */
export function mdxSyntax(ranges: readonly MdxRange[] = []): Extension {
  return [
    mdxRangesField.init(() => syntaxState(ranges)),
    EditorView.baseTheme({
      ".cm-mdx-esm": { color: "var(--mdx-esm, #795da3)" },
      ".cm-mdx-tag-name": { color: "var(--mdx-tag, #22863a)" },
      ".cm-mdx-attribute": { color: "var(--mdx-attribute, #6f42c1)" },
      ".cm-mdx-expression": { color: "var(--mdx-expression, #b35c00)" },
      ".cm-mdx-comment": { color: "var(--mdx-comment, #6a737d)" },
      "&dark .cm-mdx-esm": { color: "var(--mdx-esm, #c9a7eb)" },
      "&dark .cm-mdx-tag-name": { color: "var(--mdx-tag, #9cd69d)" },
      "&dark .cm-mdx-attribute": { color: "var(--mdx-attribute, #d2a8ff)" },
      "&dark .cm-mdx-expression": { color: "var(--mdx-expression, #efb366)" },
      "&dark .cm-mdx-comment": { color: "var(--mdx-comment, #9da7b3)" },
    }),
  ];
}

export function getMdxRanges(state: EditorState): readonly MdxRange[] {
  return state.field(mdxRangesField, false)?.ranges ?? [];
}

/** Half-open membership, including Markdown children inside JSX elements. */
export function isInMdxRange(state: EditorState, position: number): boolean {
  const ranges = state.field(mdxRangesField, false)?.protected;
  if (!ranges) return false;
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const range = ranges[mid]!;
    if (position < range.start) hi = mid;
    else if (position >= range.end) lo = mid + 1;
    else return true;
  }
  return false;
}

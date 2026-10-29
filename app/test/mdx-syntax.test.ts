import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { getMdxRanges, isInMdxRange, mdxRangesField, mdxSyntax, setMdxRanges } from "../src/renderer/mdx-syntax";
import { findMdxRanges } from "../src/shared/mdx-ranges";

function marks(state: EditorState) {
  const result: { from: number; to: number; className: string; type: unknown }[] = [];
  state.field(mdxRangesField).decorations.between(0, state.doc.length, (from, to, value) => {
    result.push({ from, to, className: value.spec.class, type: value.spec.widget });
  });
  return result;
}

describe("mdxSyntax", () => {
  test("adds highlight marks without changing, replacing, or folding source", () => {
    const source = 'import X from "x"\n\n<A className="x" value={1}>\n\n**children**\n\n</A>\n\n{/* comment */}';
    const state = EditorState.create({ doc: source, extensions: mdxSyntax(findMdxRanges(source)) });
    expect(state.doc.toString()).toBe(source);
    expect(marks(state).map((mark) => [state.sliceDoc(mark.from, mark.to), mark.className])).toEqual([
      ['import X from "x"', "cm-mdx-esm"], ["A", "cm-mdx-tag-name"], ["className", "cm-mdx-attribute"],
      ["value", "cm-mdx-attribute"], ["{1}", "cm-mdx-expression"], ["A", "cm-mdx-tag-name"], ["{/* comment */}", "cm-mdx-comment"],
    ]);
    expect(marks(state).every((mark) => mark.type === undefined)).toBe(true);
    expect(isInMdxRange(state, source.indexOf("**children**"))).toBe(true);
    const end = source.indexOf("</A>") + 4;
    expect(isInMdxRange(state, end)).toBe(false);
  });

  test("maps source ranges, lines, and highlights through insertions before and inside MDX", () => {
    const source = "text <Card className=\"x\" /> tail";
    let state = EditorState.create({ doc: source, extensions: mdxSyntax(findMdxRanges(source)) });
    state = state.update({ changes: { from: 0, insert: "😀\n" } }).state;
    expect(getMdxRanges(state)[0]?.start).toBe(8);
    expect(getMdxRanges(state)[0]?.startLine).toBe(2);
    const at = state.doc.toString().indexOf("Card") + 4;
    state = state.update({ changes: { from: at, insert: "Extra" } }).state;
    const tag = marks(state).find((mark) => mark.className === "cm-mdx-tag-name")!;
    expect(state.sliceDoc(tag.from, tag.to)).toBe("CardExtra");
    expect(isInMdxRange(state, at + 2)).toBe(true);
    expect(state.doc.toString()).toBe("😀\ntext <CardExtra className=\"x\" /> tail");
  });

  test("deletion removes empty ranges and a reparse replaces stale ranges", () => {
    const source = "before <A /> after <B />";
    let state = EditorState.create({ doc: source, extensions: mdxSyntax(findMdxRanges(source)) });
    state = state.update({ changes: { from: 7, to: 12 } }).state;
    expect(getMdxRanges(state)).toHaveLength(1);
    expect(isInMdxRange(state, 7)).toBe(false);
    expect(isInMdxRange(state, state.doc.toString().indexOf("<B"))).toBe(true);
    state = state.update({ effects: setMdxRanges.of([]) }).state;
    expect(getMdxRanges(state)).toEqual([]);
    expect(marks(state)).toEqual([]);
    const text = state.doc.toString();
    state = state.update({ effects: setMdxRanges.of(findMdxRanges(text)) }).state;
    expect(getMdxRanges(state)).toHaveLength(1);
    expect(state.doc.toString()).toBe(text);
  });

  test("nested range membership covers the outer children and works without an extension", () => {
    const text = "<A>\n\n<B />\n\n**child**\n\n</A>";
    const state = EditorState.create({ doc: text, extensions: mdxSyntax(findMdxRanges(text)) });
    for (let i = 0; i < text.length; i++) expect(isInMdxRange(state, i)).toBe(true);
    expect(isInMdxRange(state, text.length)).toBe(false);
    const plain = EditorState.create({ doc: text });
    expect(isInMdxRange(plain, 0)).toBe(false);
    expect(getMdxRanges(plain)).toEqual([]);
  });

  test("simultaneous changes and replacement ranges use the new document coordinates", () => {
    const state = EditorState.create({ doc: "old", extensions: mdxSyntax() });
    const text = "<New />";
    const updated = state.update({ changes: { from: 0, to: 3, insert: text }, effects: setMdxRanges.of(findMdxRanges(text)) }).state;
    expect(updated.doc.toString()).toBe(text);
    expect(getMdxRanges(updated)[0]?.end).toBe(text.length);
    expect(isInMdxRange(updated, text.length - 1)).toBe(true);
  });
});

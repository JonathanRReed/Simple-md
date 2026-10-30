import { ensureSyntaxTree } from "@codemirror/language";
import type { ChangeDesc, EditorState, Transaction, Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { getMdxRanges } from "./mdx-syntax.js";

export interface Region { from: number; to: number }
interface MathLine extends Region { open: boolean; close: boolean; single: boolean }

/** This scanner chooses widget boundaries only. The author sanitizer grants HTML privileges. */
function imageHtmlEnd(source: string, from: number): number | null {
  const tags = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][a-z0-9:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  tags.lastIndex = from;
  const first = tags.exec(source);
  if (!first || first.index !== from || !["img", "picture", "figure", "figcaption", "a"].includes(first[1] ?? "")) return null;
  if (first[1] === "img") return tags.lastIndex;
  const stack = [first[1]];
  let image = false;
  for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
    const name = tag[1];
    if (!name) continue;
    if (name === "img") image = true;
    if (tag[0].startsWith("</")) {
      if (stack.at(-1) !== name) return null;
      stack.pop();
      if (!stack.length) return first[1] !== "a" || image ? tags.lastIndex : null;
    } else if (!["img", "source", "br", "hr", "wbr"].includes(name) && !tag[0].endsWith("/>")) stack.push(name);
  }
  return null;
}

const htmlRegions = new WeakMap<Tree, { doc: Text; ranges: Region[] }>();

export function imageHtmlRegions(state: EditorState, tree: Tree): Region[] {
  const cached = htmlRegions.get(tree);
  if (cached?.doc === state.doc) return cached.ranges;
  const ranges: Region[] = [];
  const source = state.doc.toString();
  tree.iterate({ enter(ref) {
    if (["FencedCode", "CodeBlock", "InlineCode", "CommentBlock"].includes(ref.name)) return false;
    if (ref.name !== "HTMLBlock" && ref.name !== "HTMLTag") return;
    if ((ranges.at(-1)?.to ?? -1) > ref.from) return false;
    let from = ref.from;
    while (from < ref.to) {
      const to = imageHtmlEnd(source, from);
      if (to === null) break;
      ranges.push({ from, to });
      from = to;
      while (from < ref.to && /\s/.test(source[from]!)) from++;
    }
    return false;
  } });
  htmlRegions.set(tree, { doc: state.doc, ranges });
  return ranges;
}

export function mergeRegions(regions: readonly Region[]): Region[] {
  const result: Region[] = [];
  for (const region of [...regions].sort((a, b) => a.from - b.from)) {
    const last = result.at(-1);
    if (last && region.from <= last.to) last.to = Math.max(last.to, region.to);
    else result.push({ ...region });
  }
  return result;
}

export function mapRegion(region: Region, changes: ChangeDesc): Region {
  return { from: changes.mapPos(region.from, -1), to: changes.mapPos(region.to, 1) };
}

export function liveTree(state: EditorState): Tree | null {
  return ensureSyntaxTree(state, state.doc.length, 80);
}

/** Complete syntax blocks are the invalidation unit, including their line decorations. */
export function expandRegion(state: EditorState, tree: Tree, range: Region, math: readonly Region[]): Region {
  const doc = state.doc;
  let from = doc.lineAt(range.from).from;
  let to = doc.lineAt(range.to).to;
  const html = imageHtmlRegions(state, tree);
  for (;;) {
    const before = from, after = to;
    for (const [position, side] of [[from, 1], [to, -1]] as const) {
      let node = tree.resolve(position, side);
      while (node.parent && node.parent.name !== "Document" && !["Paragraph", "ListItem", "FencedCode", "Table", "HTMLBlock", "CommentBlock"].includes(node.name)) node = node.parent;
      if (node.name !== "Document") {
        from = Math.min(from, doc.lineAt(node.from).from);
        to = Math.max(to, doc.lineAt(node.to).to);
      }
    }
    for (const block of [...math, ...html]) if (block.from <= to && block.to >= from) {
      from = Math.min(from, block.from);
      to = Math.max(to, block.to);
    }
    if (from === before && to === after) return { from, to };
  }
}

function scanMathLines(state: EditorState, regions: readonly Region[]): MathLine[] {
  const result: MathLine[] = [];
  for (const region of mergeRegions(regions)) {
    const last = state.doc.lineAt(region.to).number;
    for (let n = state.doc.lineAt(region.from).number; n <= last; n++) {
      const line = state.doc.line(n);
      const text = line.text.trim();
      const open = text.startsWith("$$"), close = text.endsWith("$$");
      if (open || close) result.push({ from: line.from, to: line.to, open, close, single: open && close && text.length > 3 });
    }
  }
  return result;
}

/** Only edited lines are rescanned for delimiters. Selection changes reuse this index. */
export function mathLines(state: EditorState, previous?: readonly MathLine[], tr?: Transaction): MathLine[] {
  if (!previous || !tr) return scanMathLines(state, [{ from: 0, to: state.doc.length }]);
  const removed: Region[] = [], added: Region[] = [];
  tr.changes.iterChangedRanges((a, b, c, d) => {
    removed.push({ from: tr.startState.doc.lineAt(a).from, to: tr.startState.doc.lineAt(b).to });
    added.push({ from: state.doc.lineAt(c).from, to: state.doc.lineAt(d).to });
  });
  return [...previous.filter(line => !removed.some(r => line.from <= r.to && line.to >= r.from))
    .map(line => ({ ...line, ...mapRegion(line, tr.changes) })), ...scanMathLines(state, added)].sort((a, b) => a.from - b.from);
}

export function displayMath(state: EditorState, tree: Tree, lines: readonly MathLine[], fmEnd: number): Region[] {
  const result: Region[] = [];
  const mdx = getMdxRanges(state);
  const blocked = (from: number, to: number) => {
    if (from < fmEnd || mdx.some(r => r.start < to && r.end > from)) return true;
    let found = false;
    tree.iterate({ from, to, enter(node) {
      if (node.to <= from || node.from >= to) return false;
      if (["FencedCode", "Table", "HTMLBlock", "CommentBlock"].includes(node.name)) { found = true; return false; }
    } });
    return found;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.open || blocked(line.from, line.to)) continue;
    let end = i;
    if (!line.single) {
      end++;
      while (end < lines.length && !lines[end]!.close) end++;
      if (end === lines.length) continue;
    }
    const to = lines[end]!.to;
    i = end;
    if (!blocked(line.from, to)) result.push({ from: line.from, to });
  }
  return result;
}

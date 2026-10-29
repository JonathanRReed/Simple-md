import { ensureSyntaxTree } from "@codemirror/language";
import type { ChangeDesc, EditorState, Transaction } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { getMdxRanges } from "./mdx-syntax.js";

export interface Region { from: number; to: number }
interface MathLine extends Region { open: boolean; close: boolean; single: boolean }

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
    for (const block of math) if (block.from <= to && block.to >= from) {
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

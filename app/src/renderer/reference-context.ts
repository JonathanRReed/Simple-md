import type { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { getMdxRanges } from "./mdx-syntax.js";

function imageHtmlEnd(source: string, from: number): number | null {
  const tags = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][a-z0-9:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  tags.lastIndex = from;
  const first = tags.exec(source);
  if (!first || first.index !== from || !["img", "picture", "figure", "figcaption", "a", "div", "p"].includes(first[1] ?? "")) return null;
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


interface Region { from: number; to: number }
const contexts = new WeakMap<Tree, { doc: EditorState["doc"]; mdx: ReturnType<typeof getMdxRanges> | null; text: string; codeHtml: Region[]; images: Region[]; definitions: Map<string, string> }>();

/** Reuse Markdown's definition boundaries, including multiline destinations/titles. */
export function liveContext(state: EditorState, tree: Tree) {
  const ranges = getMdxRanges(state);
  const mdx = ranges.length ? ranges : null;
  const cached = contexts.get(tree);
  if (cached?.doc === state.doc && cached.mdx === mdx) return cached;
  const definitions = new Map<string, string>(), images: Region[] = [], codeHtml: Region[] = [];
  const sourceText = state.doc.toString();
  let codeStart: number | undefined;
  const frontmatter = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(state.doc.sliceString(0, 4000))?.[0].length ?? 0;
  tree.iterate({ enter(node) {
    if (["FencedCode", "CodeBlock", "InlineCode", "CommentBlock"].includes(node.name)) return false;
    if (node.name === "HTMLTag") {
      const tag = state.sliceDoc(node.from, node.to);
      if (/^<(?:code|pre)\b/i.test(tag) && codeStart === undefined) codeStart = node.from;
      else if (/^<\/(?:code|pre)\s*>/i.test(tag) && codeStart !== undefined) { codeHtml.push({ from: codeStart, to: node.to }); codeStart = undefined; }
    }
    if (node.name === "HTMLTag" || node.name === "HTMLBlock") {
      if ((images.at(-1)?.to ?? -1) <= node.from) {
        let from = node.from;
        while (from < node.to) {
          const to = imageHtmlEnd(sourceText, from);
          if (to === null) break;
          images.push({ from, to }); from = to;
          while (from < node.to && /\s/.test(sourceText[from]!)) from++;
        }
      }
      return false;
    }
    if (node.name !== "LinkReference") return;
    if (node.from >= frontmatter && !ranges.some(range => range.start < node.to && range.end > node.from)) {
      const first = state.doc.lineAt(node.from);
      const prefix = first.text.slice(0, node.from - first.from);
      const quotes = prefix.match(/>/g)?.length ?? 0;
      const indent = prefix.replace(/>[ \t]?/g, "").length;
      const source = state.sliceDoc(node.from, node.to).split("\n").map((line, i) => {
        if (!i) return line;
        for (let depth = 0; depth < quotes; depth++) line = line.replace(/^[ \t]*>[ \t]?/, "");
        return line.replace(new RegExp(`^[ \\t]{0,${indent}}`), "");
      }).join("\n");
      const label = /^\[((?:\\.|[^\]])+)\]:/.exec(source)?.[1];
      if (label && !definitions.has(normalizeLabel(label))) definitions.set(normalizeLabel(label), source);
    }
    return false;
  } });
  if (codeStart !== undefined) codeHtml.push({ from: codeStart, to: state.doc.length });
  const context = { doc: state.doc, mdx, text: [...definitions.values()].join("\n\n"), codeHtml, images, definitions };
  contexts.set(tree, context);
  return context;
}
const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();

/** A widget carries only the definitions named by its source, including shortcut references. */
export function referenceContext(state: EditorState, tree: Tree, source?: string): string {
  const context = liveContext(state, tree);
  if (source === undefined) return context.text;
  const labels = new Set<string>();
  const prose = source.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "");
  for (const match of prose.matchAll(/!?\[((?:\\.|[^\]\\])*)\](?:[ \t]*(?:\n[ \t]*)?\[((?:\\.|[^\]\\])*)\])?/g)) {
    let slashes = 0;
    for (let at = match.index - 1; prose[at] === "\\"; at--) slashes++;
    if (slashes % 2 || match[2] === undefined && prose[match.index + match[0].length] === "(") continue;
    labels.add(normalizeLabel(match[2] || match[1]!));
  }
  return [...context.definitions].filter(([label]) => labels.has(label)).map(([, definition]) => definition).join("\n\n");
}

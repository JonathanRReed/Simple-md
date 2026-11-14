import { createMarkdownParser } from "../shared/markdown-parser.js";
import { taskMarkerPositions } from "./tasks.js";
import { findMdxRanges } from "../shared/mdx-ranges.js";
import { changedSelection, dominantEnding, preserveFinalNewline, sourceLines, type SourceEdit, type SourceSelection } from "./source-edit.js";

const markdown = createMarkdownParser();

export type BlockCommand = "body" | `heading-${1 | 2 | 3 | 4 | 5 | 6}` | "bullet-list" | "number-list" | "task-list" | "quote" | "code-block" | "rule" | "footnote" | "toggle-task";

// Keep indentation and enclosing quotes when changing the innermost block prefix.
function prefix(line: string) {
  const quote = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line)![0];
  const rest = line.slice(quote.length);
  const mark = /^(?:#{1,6}(?:[ \t]+|$)|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/.exec(rest)?.[0] ?? "";
  return { quote, mark, rest };
}
function blockEditRaw(text: string, selection: SourceSelection, command: BlockCommand, mdx = false): SourceEdit {
  const lines = sourceLines(text);
  const first = lines.findIndex(line => selection.from <= line.to);
  const last = lines.findIndex((line, index) => Math.max(selection.from, selection.to - 1) < line.end || index === lines.length - 1);
  const selected = lines.slice(first, last + 1);
  const eol = dominantEnding(text);
  const unchanged = { changes: [], selection };
  const protectedLines = new Set<number>(), continuations = new Set<number>();
  const fences = new Set<string>(), fencedLines = new Set<number>();
  if (lines[0]?.text === "---") {
    const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)$/.test(line.text));
    for (let i = 0; i <= (end < 0 ? lines.length - 1 : end); i++) protectedLines.add(i);
  }
  const ranges = mdx || /^(?:import|export)\s/m.test(text) ? findMdxRanges(text) : undefined;
  if (ranges) for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ranges.some(range => range.kind === "esm" && range.start <= line.to && range.end > line.from) || ranges.error && ranges.error.start <= line.to && ranges.error.end > line.from) protectedLines.add(i);
  }
  for (const token of markdown.parse(text.replace(/^\uFEFF/, ""), {})) {
    if (!token.map) continue;
    const [start, end] = token.map;
    if (token.type === "fence") {
      fences.add(`${start}:${end - 1}`);
      for (let i = start; i < end; i++) fencedLines.add(i);
    }
    if (token.type === "list_item_open") for (let i = start + 1; i < end; i++) {
      if (!/^(?:[-+*]|\d+[.)])[ \t]+/.test(prefix(lines[i]!.text).rest)) continuations.add(i);
    }
  }
  if (command === "footnote" || command === "rule") {
    const insertion = command === "footnote" ? lines.findIndex(line => selection.to <= line.to) : first;
    if (protectedLines.has(first) || fencedLines.has(first) || protectedLines.has(insertion) || fencedLines.has(insertion)) return unchanged;
  }
  if (command === "footnote") {
    const used = new Set([...text.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1])));
    let n = 1; while (used.has(n)) n++;
    const reference = `[^${n}]`, referenceAt = selection.to;
    const final = /[\r\n]$/.test(text);
    const definition = `${referenceAt === text.length ? eol + eol : text.length > (text.startsWith("\uFEFF") ? 1 : 0) ? final ? eol : eol + eol : ""}[^${n}]: `;
    // Two insertions at EOF must be ordered explicitly.
    const changes = referenceAt === text.length
      ? [{ from: text.length, to: text.length, insert: reference + definition + (final ? eol : "") }]
      : [{ from: referenceAt, to: referenceAt, insert: reference }, { from: text.length, to: text.length, insert: definition + (final ? eol : "") }];
    const at = text.length + reference.length + definition.length;
    return { changes, selection: { from: at, to: at } };
  }
  if (command === "code-block") {
    const from = selected[0]!.from, to = selected.at(-1)!.to;
    const body = text.slice(from, to);
    const opening = /^([ \t]*(?:>[ \t]?)*)(`{3,}|~{3,})[^\r\n]*$/.exec(selected[0]!.text);
    if (selected.some((_line, i) => protectedLines.has(first + i))) return unchanged;
    if (selected.some((_line, i) => fencedLines.has(first + i)) && !fences.has(`${first}:${last}`)) return unchanged;
    if (selected.length > 1 && opening && new RegExp(`^[ \\t]*(?:>[ \\t]?)*${opening[2]![0]}{${opening[2]!.length},}[ \\t]*$`).test(selected.at(-1)!.text)) {
      const body = selected.slice(1, -1).map(line => line.text + line.ending).join("").replace(/(?:\r\n|\r|\n)$/, "");
      const changes = [{ from, to, insert: body }];
      return changedSelection(selection, changes);
    }
    if (selected.some((_line, i) => fencedLines.has(first + i))) return unchanged;
    const container = prefix(selected[0]!.text).quote;
    if (selected.some(line => prefix(line.text).quote !== container)) return unchanged;
    const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const at = from + container.length;
    const changes = from === to ? [{ from, to, insert: fence + eol + eol + fence }] : [{ from: at, to: at, insert: fence + eol + container }, { from: to, to, insert: eol + container + fence }];
    return { changes, selection: { from: at + fence.length, to: at + fence.length } };
  }
  if (command === "rule") {
    const line = selected[0]!;
    const previous = lines[first - 1], next = lines[first + 1];
    const before = line.text.trim() ? eol + eol : previous?.text.trim() ? eol : "";
    const after = next?.text.trim() ? eol : line.ending ? "" : /[\r\n]$/.test(text) ? eol : "";
    return changedSelection(selection, [{ from: line.to, to: line.to, insert: before + "---" + after }]);
  }
  if (command === "toggle-task") {
    const from = selected[0]!.from, to = selected.at(-1)!.to;
    const positions = taskMarkerPositions(text, ranges);
    let index = first;
    return changedSelection(selection, positions.sort((a, b) => a - b).filter(at => {
      if (at < from || at > to) return false;
      while (index < last && at > lines[index]!.to) index++;
      return !protectedLines.has(index) && !fencedLines.has(index) && (!ranges?.error || at < ranges.error.start || at >= ranges.error.end);
    }).map(at => ({ from: at, to: at + 1, insert: text[at] === " " ? "x" : " " })));
  }
  const matches = (mark: string) => command.startsWith("heading-") ? new RegExp(`^#{${Number(command.slice(-1))}}[ \t]*$`).test(mark)
    : command === "bullet-list" ? /^[-+*]\s+$/.test(mark)
    : command === "number-list" ? /^\d+[.)]\s+$/.test(mark)
    : command === "task-list" ? /^[-+*]\s+\[[ xX]\]\s+$/.test(mark) : false;
  const editable = selected.filter((line, i) => !protectedLines.has(first + i) && !fencedLines.has(first + i) && !continuations.has(first + i) && prefix(line.text).rest.trim());
  const remove = editable.every(line => matches(prefix(line.text).mark));
  const unquote = command === "quote" && editable.every(line => /^[ \t]*>/.test(line.text));
  let number = 0;
  const changes = editable.flatMap(line => {
    const { quote, mark } = prefix(line.text);
    if (command === "quote") {
      const match = /^([ \t]*)>[ \t]?/.exec(line.text);
      const at = line.from + (unquote ? match![1]!.length : 0);
      return [{ from: at, to: line.from + (unquote ? match![0].length : 0), insert: unquote ? "" : "> " }];
    }
    const insert = command === "body" || remove ? "" : command.startsWith("heading-") ? "#".repeat(Number(command.slice(-1))) + " "
      : command === "bullet-list" ? "- " : command === "number-list" ? `${++number}. ` : "- [ ] ";
    return [{ from: line.from + quote.length, to: line.from + quote.length + mark.length, insert }];
  });
  return changedSelection(selection, changes);
}

export function blockEdit(text: string, selection: SourceSelection, command: BlockCommand, mdx = false): SourceEdit {
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  selection = { from: Math.max(bom, selection.from), to: Math.max(bom, selection.to) };
  return preserveFinalNewline(text, blockEditRaw(text, selection, command, mdx));
}

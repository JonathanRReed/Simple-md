import { taskMarkerPositions } from "./tasks.js";
import { findMdxRanges } from "../shared/mdx-ranges.js";
import { changedSelection, dominantEnding, preserveFinalNewline, sourceLines, type SourceEdit, type SourceSelection } from "./source-edit.js";

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
    if (selected.length > 1 && opening && new RegExp(`^[ \\t]*(?:>[ \\t]?)*${opening[2]![0]}{${opening[2]!.length},}[ \\t]*$`).test(selected.at(-1)!.text)) {
      const body = selected.slice(1, -1).map(line => line.text + line.ending).join("").replace(/(?:\r\n|\r|\n)$/, "");
      const changes = [{ from, to, insert: body }];
      return changedSelection(selection, changes);
    }
    const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const changes = from === to ? [{ from, to, insert: fence + eol + eol + fence }] : [{ from, to: from, insert: fence + eol }, { from: to, to, insert: eol + fence }];
    return { changes, selection: { from: from + fence.length, to: from + fence.length } };
  }
  if (command === "rule") {
    const line = selected[0]!;
    const rule = /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line.text);
    const value = rule ? "" : `${line.text ? eol + eol : ""}---`;
    const changes = [{ from: rule ? line.from : line.to, to: line.to, insert: value }];
    return changedSelection(selection, changes);
  }
  if (command === "toggle-task") {
    const from = selected[0]!.from, to = selected.at(-1)!.to;
    const ranges = mdx ? findMdxRanges(text) : undefined;
    const positions = taskMarkerPositions(text, ranges);
    return changedSelection(selection, positions.filter(at => at >= from && at <= to && (!ranges?.error || at < ranges.error.start || at >= ranges.error.end)).sort((a, b) => a - b).map(at => ({ from: at, to: at + 1, insert: text[at] === " " ? "x" : " " })));
  }
  const matches = (mark: string) => command.startsWith("heading-") ? new RegExp(`^#{${Number(command.slice(-1))}}[ \t]*$`).test(mark)
    : command === "bullet-list" ? /^[-+*]\s+$/.test(mark)
    : command === "number-list" ? /^\d+[.)]\s+$/.test(mark)
    : command === "task-list" ? /^[-+*]\s+\[[ xX]\]\s+$/.test(mark) : false;
  const remove = selected.every(line => matches(prefix(line.text).mark));
  const unquote = command === "quote" && selected.every(line => /^[ \t]*>/.test(line.text));
  let number = 0;
  const changes = selected.flatMap(line => {
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

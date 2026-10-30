import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { DecorationSet } from "@codemirror/view";
import { buildLiveDecorations, liveDecorationField, setLiveViewport, type LiveHost } from "../../src/renderer/live";
import { expandRegion, liveTree } from "../../src/renderer/live-regions";
import { getMdxRanges, mdxSyntax, setMdxRanges } from "../../src/renderer/mdx-syntax";
import { findMdxRanges } from "../../src/shared/mdx-ranges";

const host: LiveHost = { baseUrl: () => null, openLink() {}, renderFragment: async () => ({ html: "", urls: {} }) };
function snapshot(decorations: DecorationSet): unknown[] {
  const result = [];
  for (let c = decorations.iter(); c.value; c.next()) {
    const spec = c.value.spec;
    const widget = spec.widget;
    result.push([c.from, c.to, spec.class, spec.attributes, spec.block, widget && [widget.constructor.name, widget.source, widget.kind, widget.tex, widget.checked, widget.at]]);
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function runBatch(fixtures: string[]) {
  let seed = 91741, comparisons = 0;
  const rand = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const failures = [];
  const inserts = ["x", "\n", "$$", "\n\n", "**", "~~~", "|", "---", "<Card>", "</Card>", "$x$", "![a](x)", "😀", "- [x] "];
  for (const [fixture, doc] of fixtures.entries()) {
    const field = liveDecorationField(host);
    let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), mdxSyntax(findMdxRanges(doc)), field, EditorState.allowMultipleSelections.of(true)] });
    for (let step = 0; step < 450; step++) {
      const from = rand(state.doc.length + 1), to = Math.min(state.doc.length, from + rand(6));
      if (step % 31 === 0) state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.range(from, to)]) }).state;
      else if (step % 3 === 0) state = state.update({ selection: EditorSelection.create([EditorSelection.range(from, to)]) }).state;
      else if (step % 17 === 0) state = state.update({ effects: setMdxRanges.of(findMdxRanges(state.doc.toString())) }).state;
      else if (step % 19 === 0) state = state.update({ effects: setLiveViewport.of({ from, to: Math.min(state.doc.length, from + 300) }) }).state;
      else state = state.update({ changes: { from, to, insert: inserts[rand(inserts.length)]! } }).state;
      const value = state.field(field);
      const tree = liveTree(state)!;
      const scope = expandRegion(state, tree, value.viewport, value.math);
      const full = buildLiveDecorations(state, host, scope);
      for (let c = value.decorations.iter(); c.value; c.next()) {
        const spec = c.value.spec;
        const overlaps = getMdxRanges(state).filter(r => r.start < c.to && r.end > c.from);
        const imageHtml = spec.widget?.kind?.startsWith("html") && overlaps.every(range => "capitalized" in range && !range.capitalized);
        if ((spec.widget || !spec.class && c.from < c.to) && overlaps.length && !imageHtml) {
          throw new Error(`Decoration hid MDX in fixture ${fixture} at step ${step}`);
        }
      }
      const actual = snapshot(value.decorations), expected = snapshot(full);
      comparisons++;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push({ fixture, step, from, to, viewport: value.viewport, scope, doc: state.doc.toString(), actual, expected });
        return { comparisons, failures };
      }
    }
  }
  const field = liveDecorationField(host);
  const doc = "# Heading\n\n$$x$$\n\nEnd";
  let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), field] });
  state = state.update({ changes: { from: doc.length, insert: "\n\n" + "text ".repeat(60000) } }).state;
  if (state.field(field).decorations.size) throw new Error("Oversize live document retained decorations");
  state = state.update({ changes: { from: doc.length, to: state.doc.length } }).state;
  comparisons++;
  const actual = snapshot(state.field(field).decorations), expected = snapshot(buildLiveDecorations(state, host));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({ fixture: -1, step: 0, from: 0, to: doc.length, viewport: state.field(field).viewport, scope: { from: 0, to: doc.length }, doc, actual, expected });
  return { comparisons, failures };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

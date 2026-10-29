import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { buildLiveDecorations, liveDecorationField, setLiveViewport, type LiveHost } from "../../src/renderer/live";
import { liveTree } from "../../src/renderer/live-regions";

const host: LiveHost = { baseUrl: () => null, openLink() {}, renderFragment: async () => ({ html: "", urls: {} }) };
function runBatch(doc: string) {
  const field = liveDecorationField(host);
  const center = Math.floor(doc.length / 2);
  let incremental = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), field] });
  incremental = incremental.update({ effects: setLiveViewport.of({ from: center - 1200, to: center + 1200 }) }).state;
  let full = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  liveTree(full);
  let lineReads = 0;
  for (const state of [incremental, full]) {
    const line = state.doc.line.bind(state.doc);
    state.doc.line = number => { lineReads++; return line(number); };
    state.doc.toString = () => { throw new Error("Whole-document string conversion in selection update"); };
  }
  const samples: { side: string; ms: number; lineReads: number; decorations: number }[] = [];
  for (let pair = 0; pair < 6; pair++) for (const side of ["full", "incremental"]) {
    lineReads = 0;
    let decorations = 0;
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const anchor = center - 900 + (i * 37) % 1800;
      if (side === "full") {
        full = full.update({ selection: { anchor } }).state;
        decorations += buildLiveDecorations(full, host).size;
      } else {
        incremental = incremental.update({ selection: { anchor } }).state;
        decorations += incremental.field(field).decorations.size;
      }
    }
    const ms = performance.now() - start;
    if (pair) samples.push({ side, ms, lineReads, decorations });
  }
  return { characters: doc.length, lines: full.doc.lines, selectionsPerSample: 100, samples };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

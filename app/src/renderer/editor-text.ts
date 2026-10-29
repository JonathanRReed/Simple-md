import { type EditorState, StateField, Text } from "@codemirror/state";
import { byteText, exactText, restoreByteText } from "./byte-text.js";

const endings: Record<string, string> = { n: "\n", c: "\r\n", r: "\r" };

function offsets(state: EditorState): Text {
  // Each CRLF adds one code unit beyond CodeMirror's normalized newline.
  // Text's line offsets give a persistent prefix sum without walking prior lines.
  return Text.of([...state.field(byteText).breaks.iterLines()].map(ending => ending === "c" ? "c" : ""));
}

function insertedText(state: EditorState, from: number, to: number): string {
  const first = state.doc.lineAt(from).number;
  const breaks = state.field(byteText).breaks;
  const lines = state.doc.sliceString(from, to).split("\n");
  return lines.map((line, index) => line + (index < lines.length - 1 ? endings[breaks.line(first + index).text] ?? "\n" : "")).join("");
}

/** Keep the existing string callback without serializing every unchanged line per key. */
export const editorText = StateField.define({
  create: state => ({ text: exactText(state), offsets: offsets(state) }),
  update(value, tr) {
    if (tr.effects.some(effect => effect.is(restoreByteText))) return { text: exactText(tr.state), offsets: offsets(tr.state) };
    if (!tr.docChanged) return value;
    const old = tr.startState.doc;
    const bomLength = tr.startState.field(byteText).bom.length;
    const byteOffset = (position: number) => {
      const line = old.lineAt(position).number;
      return position + bomLength + value.offsets.line(line).from - (line - 1);
    };
    const changes: { from: number; to: number; insert: string }[] = [];
    let nextOffsets = value.offsets;
    let lineDelta = 0;
    tr.changes.iterChanges((a, b, c, d, inserted) => {
      changes.push({ from: byteOffset(a), to: byteOffset(b), insert: insertedText(tr.state, c, d) });
      const first = old.lineAt(a).number, last = old.lineAt(b).number;
      if (first === last && inserted.lines === 1) return;
      const breaks = tr.state.field(byteText).breaks;
      const newFirst = tr.state.doc.lineAt(c).number;
      nextOffsets = nextOffsets.replace(nextOffsets.line(first + lineDelta).from, nextOffsets.line(last + lineDelta).from,
        Text.of([...Array.from({ length: inserted.lines - 1 }, (_, i) => breaks.line(newFirst + i).text === "c" ? "c" : ""), ""]));
      lineDelta += inserted.lines - 1 - (last - first);
    });
    let text = value.text;
    for (const change of changes.reverse()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
    return { text, offsets: nextOffsets };
  },
});

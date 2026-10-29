import { invertedEffects } from "@codemirror/commands";
import { type EditorState, StateEffect, StateField, Text } from "@codemirror/state";

const ENDINGS: Record<string, string> = { n: "\n", c: "\r\n", r: "\r" };

export function parseByteText(source: string) {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const breaks: string[] = [];
  const counts = { n: 0, c: 0, r: 0 };
  const text = source.slice(bom.length).replace(/\r\n|\r|\n/g, (ending) => {
    const code = ending === "\r\n" ? "c" : ending === "\r" ? "r" : "n";
    breaks.push(code);
    counts[code]++;
    return "\n";
  });
  const dominant = counts.c > counts.n && counts.c > counts.r ? "c" : counts.r > counts.n && counts.r > counts.c ? "r" : "n";
  return { text, format: { bom, dominant, breaks: Text.of([...breaks, ""]) } };
}

export const restoreByteText = StateEffect.define<ReturnType<typeof parseByteText>["format"]>();

export const byteText = StateField.define({
  create: () => parseByteText("").format,
  update(format, tr) {
    // History groups effects newest first, so the last snapshot is the original format.
    const restored = tr.effects.filter((effect) => effect.is(restoreByteText)).at(-1);
    if (restored) return restored.value;
    let breaks = format.breaks;
    let lineDelta = 0;
    tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      const first = tr.startState.doc.lineAt(from).number;
      const last = tr.startState.doc.lineAt(to).number;
      if (first === last && inserted.lines === 1) return;
      breaks = breaks.replace(
        breaks.line(first + lineDelta).from,
        breaks.line(last + lineDelta).from,
        Text.of([...Array<string>(inserted.lines - 1).fill(format.dominant), ""]),
      );
      lineDelta += inserted.lines - 1 - (last - first);
    });
    return breaks === format.breaks ? format : { ...format, breaks };
  },
  provide: (field) => invertedEffects.of((tr) => {
    const before = tr.startState.field(field);
    return before === tr.state.field(field) ? [] : [restoreByteText.of(before)];
  }),
});

export function exactText(state: EditorState): string {
  const format = state.field(byteText);
  const parts = [format.bom];
  const endings = format.breaks.iterLines();
  for (const line of state.doc.iterLines()) {
    parts.push(line, ENDINGS[endings.next().value] ?? "");
  }
  return parts.join("");
}

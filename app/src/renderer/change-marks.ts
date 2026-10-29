import { StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { BlockChanges } from "../shared/change-highlights.js";

export const setChangeMarks = StateEffect.define<BlockChanges>();
class DeletedMarker extends WidgetType {
  toDOM(): HTMLElement {
    const node = document.createElement("span");
    node.className = "change-deleted-widget";
    node.title = "Deleted block";
    return node;
  }
  eq(): boolean { return true; }
}
function decorations(doc: Text, changes: BlockChanges): DecorationSet {
  const marks = [];
  for (const [start, end] of changes.changed) {
    for (let line = start; line < Math.min(end, doc.lines); line++) marks.push(Decoration.line({ class: "change-highlight" }).range(doc.line(line + 1).from));
  }
  for (const line of changes.deleted) marks.push(Decoration.widget({ widget: new DeletedMarker(), side: -1 }).range(doc.line(Math.min(line + 1, doc.lines)).from));
  return Decoration.set(marks, true);
}
export const changeMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setChangeMarks)) value = decorations(transaction.state.doc, effect.value);
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

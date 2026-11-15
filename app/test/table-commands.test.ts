import { expect, test } from "bun:test";
import { tableEdit, tableAt, rowCells, type TableCommand } from "../src/renderer/table-source";
import { applySourceChanges } from "../src/renderer/source-edit";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { moveCell } from "../src/renderer/tables";
function edit(text: string, command: TableCommand, at = text.indexOf("one")) {
  const result = tableEdit(text, { from: at, to: at }, command);
  return result ? { text: applySourceChanges(text, result.changes), selection: result.selection } : null;
}
for (const eol of ["\n", "\r\n"]) for (const final of ["", eol]) for (const outside of [true, false]) {
  const row = (a: string, b: string) => outside ? `|${a}|${b}|` : `${a}|${b}`;
  const header = row(" H  ", " B "), divider = row(" --- ", " :---: ");
  const one = row(" one ", " `a|b` "), two = row(" two  ", " x\\|y ");
  const text = [header, divider, one, two].join(eol) + final;
  test(`table edits preserve untouched cells ${JSON.stringify(eol)} final ${!!final} outside ${outside}`, () => {
    expect(edit(text, "row-up", text.indexOf("two"))?.text).toBe([header, divider, two, one].join(eol) + final);
    expect(edit(text, "row-down")?.text).toBe([header, divider, two, one].join(eol) + final);
    expect(edit(text, "delete-row")?.text).toBe([header, divider, two].join(eol) + final);
    expect(edit(text, "align-right")?.text).toBe([header, row(" ---: ", " :---: "), one, two].join(eol) + final);
    expect(edit(text, "align-left")?.text).toContain(row(" :--- ", " :---: "));
    expect(edit(text, "align-center")?.text).toContain(row(" :---: ", " :---: "));
    expect(edit(text, "align-none")?.text).toBe(text);
    for (const command of ["column-left", "column-right", "row-above", "row-below"] satisfies TableCommand[]) {
      const result = edit(text, command)!;
      expect(result.text).toContain("`a|b`"); expect(result.text).toContain("x\\|y");
      expect(result.text.endsWith(eol)).toBe(!!final);
      expect(result.selection.from).toBeGreaterThanOrEqual(0);
    }
    const deleted = edit(text, "delete-column")!.text;
    expect(deleted).toContain("`a|b`"); expect(deleted).toContain("x\\|y"); expect(deleted).not.toContain("one");
    expect(edit(text, "delete-row", header.length + eol.length + 2)).toBeNull();
    expect(edit(text, "row-up")?.text).toBe([one, divider, header, two].join(eol) + final);
  });
}
test("table lexer splits unescaped pipes, including in code spans", () => {
  const line = "a\\|b | ``a|`b`` | c\\\\|d";
  expect(rowCells(line).map(cell => line.slice(cell.from, cell.to).trim())).toEqual(["a\\|b", "``a", "`b``", "c\\\\", "d"]);
  expect(tableAt(["prose", "a | b", "--- | ---", "one | two"], 3)).toEqual({ start: 1, end: 3 });
  expect(edit("prose", "column-left", 0)).toBeNull();
});
test("insert table selects the first header and separates existing prose", () => {
  const result = edit("beforeafter", "insert-table", 6)!;
  expect(result.text).toBe("before\n\n| Header | Header |\n| --- | --- |\n|  |  |\n|  |  |\n\nafter");
  expect(result.text.slice(result.selection.from, result.selection.to)).toBe("Header");
});
test("deleting last column and last row keeps final newline state", () => {
  expect(edit("| H |\r\n| --- |\r\n| one |", "delete-column")?.text).toBe("");
  expect(edit("a | b\r\n--- | ---\r\none | two", "delete-row")?.text).toBe("a | b\r\n--- | ---");
});
test("pipe-less Tab/Shift-Tab navigate, skip delimiter and append", () => {
  const text = "a | b\n--- | ---\none | two";
  let state = EditorState.create({ doc: text, selection: { anchor: 0 }, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, text.length, 1000);
  const view = { get state() { return state; }, dispatch(spec: Parameters<EditorState["update"]>[0]) { state = state.update(spec).state; } } as unknown as EditorView;
  for (const expected of ["b", "one", "two"]) { expect(moveCell(view, 1)).toBe(true); expect(state.sliceDoc(state.selection.main.head)).toStartWith(expected); }
  expect(moveCell(view, -1)).toBe(true); expect(state.sliceDoc(state.selection.main.head)).toStartWith("one");
  moveCell(view, 1); moveCell(view, 1);
  expect(state.doc.lines).toBe(4);
});

test("deleting the header promotes the first body row and preserves delimiter padding", () => {
  expect(edit("| H | B |\r\n| :--- | ---: |\r\n| one | two |\r\n| last | end |", "delete-row", 2)?.text).toBe("| one | two |\r\n| :--- | ---: |\r\n| last | end |");
  expect(edit("A | B\n--- | ---\none | two", "delete-column")?.text).toBe("| B|\n| ---|\n| two|");
});

test("header insertion and movement keep the delimiter in its structural position", () => {
  const text = "| H | B |\n| --- | --- |\n| one | two |";
  expect(edit(text, "row-above", 2)?.text).toBe("|  |  |\n| --- | --- |\n| H | B |\n| one | two |");
  expect(edit(text, "row-down", 2)?.text).toBe("| one | two |\n| --- | --- |\n| H | B |");
});

test("empty outside columns and new rows retain a valid number of cells in pipe-less tables", () => {
  const source = "A | B\n--- | ---\none | two";
  for (const command of ["row-above", "row-below"] satisfies TableCommand[]) {
    const next = edit(source, command)!;
    expect(next.text.split("\n").map(row => rowCells(row).length)).toEqual([2, 2, 2, 2]);
  }
  expect(edit(source, "column-left")!.text.split("\n").map(row => rowCells(row).length)).toEqual([3, 3, 3]);
  expect(edit(source, "column-right", source.indexOf("two"))!.text.split("\n").map(row => rowCells(row).length)).toEqual([3, 3, 3]);
});

test("removing the final table does not turn preceding separators into a final newline", () => {
  const text = "Intro\r\n\r\n| H |\r\n| --- |\r\n| one |";
  expect(edit(text, "delete-column")?.text).toBe("Intro");
});

test("quoted and list-contained table commands retain their containers", () => {
  const quote = "> | H | B |\r\n> | --- | --- |\r\n> | one | two |";
  expect(edit(quote, "align-right")?.text).toBe("> | H | B |\r\n> | ---: | --- |\r\n> | one | two |");
  expect(edit(quote, "row-below")?.text).toBe(quote + "\r\n> |  |  |");
  const list = "- A | B\n  --- | ---\n  one | two";
  expect(edit(list, "row-below")?.text).toBe(list + "\n  |  |  |");
  expect(edit(list, "delete-row")?.text).toBe("- A | B\n  --- | ---");
});
test("a following list with a pipe is outside table editing", () => {
  const source = "A | B\n--- | ---\none | two\n- Next | item";
  expect(edit(source, "column-right")?.text).toEndWith("\n- Next | item");
});
test("quoted table Tab uses parser rows and appends a quoted row", () => {
  const text = "> A | B\n> --- | ---\n> one | two";
  let state = EditorState.create({ doc: text, selection: { anchor: text.indexOf("one") }, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, text.length, 1000);
  const view = { get state() { return state; }, dispatch(spec: Parameters<EditorState["update"]>[0]) { state = state.update(spec).state; } } as unknown as EditorView;
  expect(moveCell(view, 1)).toBe(true); expect(state.sliceDoc(state.selection.main.head)).toBe("two");
  expect(moveCell(view, 1)).toBe(true); expect(state.doc.toString()).toEndWith("\n> | | |");
});

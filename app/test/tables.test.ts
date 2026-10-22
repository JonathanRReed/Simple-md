import { describe, expect, test } from "bun:test";
import { alignTable, cellIndexAt, findTable, isSeparatorLine, isTableLine, splitRow } from "../src/renderer/tables";

describe("isTableLine / isSeparatorLine", () => {
  test("pipe-led lines count, prose does not", () => {
    expect(isTableLine("| a | b |")).toBe(true);
    expect(isTableLine("  | a |")).toBe(true);
    expect(isTableLine("a | b")).toBe(false);
    expect(isTableLine("- list | item")).toBe(false);
  });

  test("separator rows with optional colons", () => {
    expect(isSeparatorLine("| --- | :---: | ---: |")).toBe(true);
    expect(isSeparatorLine("|---|---|")).toBe(true);
    expect(isSeparatorLine("| abc |")).toBe(false);
  });
});

describe("findTable", () => {
  const lines = ["intro", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "tail | x"];

  test("finds the block around any row and requires a separator", () => {
    expect(findTable(lines, 2)).toEqual({ start: 1, end: 3 });
    expect(findTable(lines, 3)).toEqual({ start: 1, end: 3 });
    expect(findTable(lines, 0)).toBeNull();
    expect(findTable(lines, 5)).toBeNull();
  });

  test("a lone pipe-led line is not a table", () => {
    expect(findTable(["| only |"], 0)).toBeNull();
  });
});

describe("splitRow", () => {
  test("trims cells and drops the outer pipes", () => {
    expect(splitRow("| a | b  |")).toEqual(["a", "b"]);
    expect(splitRow("|a|b|")).toEqual(["a", "b"]);
  });

  test("escaped pipes stay inside their cell", () => {
    expect(splitRow("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
  });
});

describe("alignTable", () => {
  test("re-pads a ragged table", () => {
    const lines = ["| a | bb |", "|---|---|", "| longer | c |"];
    expect(alignTable(lines, 0, 2)).toEqual(["| a      | bb  |", "| ------ | --- |", "| longer | c   |"]);
  });

  test("keeps alignment colons, padded with dashes", () => {
    const lines = ["| name | age |", "| :--- | ---: |", "| alexander | 1 |"];
    expect(alignTable(lines, 0, 2)).toEqual(["| name      | age |", "| :-------- | --: |", "| alexander |   1 |"]);
  });

  test("pads short rows with empty cells", () => {
    const lines = ["| a | b |", "| --- | --- |", "| 1 |"];
    expect(alignTable(lines, 0, 2)).toEqual(["| a   | b   |", "| --- | --- |", "| 1   |     |"]);
  });

  test("preserves line indentation", () => {
    const lines = ["  | a |", "  | --- |", "  | b |"];
    expect(alignTable(lines, 0, 2)).toEqual(["  | a   |", "  | --- |", "  | b   |"]);
  });
});

describe("cellIndexAt", () => {
  test("maps a character offset to a cell", () => {
    const line = "| a | bb | c |";
    expect(cellIndexAt(line, 0)).toBe(0);
    expect(cellIndexAt(line, 3)).toBe(0); // inside "a"
    expect(cellIndexAt(line, 6)).toBe(1); // inside "bb"
    expect(cellIndexAt(line, 12)).toBe(2);
  });
});

// Tab math: cellIndexAt on the aligned row plus cellOffset's "| " step lands
// the cursor at the content start of the next cell.
describe("tab navigation math", () => {
  test("next-cell target after aligning", () => {
    const aligned = alignTable(["| a | bb |", "|---|---|", "| 1 | 2 |"], 0, 2);
    const row = aligned[2]!; // "| 1  | 2  |"
    // Cursor at content of cell 0; Tab should land at content of cell 1.
    expect(cellIndexAt(row, row.indexOf("1"))).toBe(0);
    const nextPipe = row.indexOf("|", 2);
    expect(row.slice(nextPipe + 2, nextPipe + 3)).toBe("2");
  });
});

test("aligning a table never drops cells wider than its header", () => {
  expect(alignTable(["| a |", "| --- |", "| one | two |"], 0, 2)).toEqual([
    "| a   |     |", "| --- | --- |", "| one | two |",
  ]);
});

test("even backslashes leave a following pipe as a cell boundary", () => {
  expect(splitRow("| a \\\\| b |")).toEqual(["a \\\\", "b"]);
  expect(cellIndexAt("| a \\\\| b |", 9)).toBe(1);
});

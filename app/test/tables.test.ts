import { describe, expect, test } from "bun:test";
import { cellIndexAt, findTable, isSeparatorLine, isTableLine, splitRow } from "../src/renderer/tables";

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

describe("cellIndexAt", () => {
  test("maps a character offset to a cell", () => {
    const line = "| a | bb | c |";
    expect(cellIndexAt(line, 0)).toBe(0);
    expect(cellIndexAt(line, 3)).toBe(0); // inside "a"
    expect(cellIndexAt(line, 6)).toBe(1); // inside "bb"
    expect(cellIndexAt(line, 12)).toBe(2);
  });
});

test("even backslashes leave a following pipe as a cell boundary", () => {
  expect(splitRow("| a \\\\| b |")).toEqual(["a \\\\", "b"]);
  expect(cellIndexAt("| a \\\\| b |", 9)).toBe(1);
});

import { expect, test } from "bun:test";
import { calculateBlockChanges, diffSourceBlocks } from "../src/main/block-changes";

test("insertion leaves following blocks unchanged", async () => {
  expect(await calculateBlockChanges("# Title\n\nOne\n\nTwo", "# Title\n\nNew\n\nOne\n\nTwo", null))
    .toEqual({ changed: [[2, 3]], deleted: [] });
});
test("deletion marks the following boundary and the end of an empty document", async () => {
  expect(await calculateBlockChanges("# Title\n\nOne\n\nTwo", "# Title\n\nTwo", null))
    .toEqual({ changed: [], deleted: [2] });
  expect(await calculateBlockChanges("Stay\n\nGone", "Stay", null)).toEqual({ changed: [], deleted: [1] });
  expect(await calculateBlockChanges("Gone", "", null)).toEqual({ changed: [], deleted: [0] });
});
test("moved blocks get an insertion and a deletion without marking retained blocks", async () => {
  expect(await calculateBlockChanges("A\n\nB\n\nC", "B\n\nC\n\nA", null))
    .toEqual({ changed: [[4, 5]], deleted: [0] });
});
test("an edit inside a long multiline paragraph marks only that paragraph", async () => {
  const paragraph = Array.from({ length: 1000 }, (_, i) => `Line ${i} with text.`).join("\n");
  const before = `# Unchanged\n\n${paragraph}\n\nLast.`;
  expect(await calculateBlockChanges(before, before.replace("Line 500", "Edited 500"), null))
    .toEqual({ changed: [[2, 1002]], deleted: [] });
});
test("frontmatter and MDX reuse parser source ranges", async () => {
  const before = '---\ntitle: Before\n---\n\n# Same\n\n<Component>\n\nInside\n\n</Component>\n\nEnd';
  expect((await calculateBlockChanges(before, before.replace("Before", "After"), "/tmp/doc.mdx")).changed).toEqual([[0, 3]]);
  const changes = await calculateBlockChanges(before, before.replace("Inside", "Edited"), "/tmp/doc.mdx");
  expect(changes.changed.length).toBeGreaterThan(0);
  expect(changes.changed.every(([start, end]) => start >= 6 && end <= 11)).toBe(true);
});
test("CRLF and BOM preserve equivalent content fingerprints", async () => {
  expect(await calculateBlockChanges("\uFEFF# Same\r\n\r\nParagraph\r\n", "# Same\n\nParagraph\n", null)).toEqual({ changed: [], deleted: [] });
  expect(await calculateBlockChanges("# Same\r\n\r\nOld\r\n", "# Same\r\n\r\nNew\r\n", null)).toEqual({ changed: [[2, 3]], deleted: [] });
});
test("duplicate block occurrences keep ordered identities", async () => {
  expect(await calculateBlockChanges("Same\n\nSame\n\nLast", "Same\n\nNew\n\nSame\n\nLast", null)).toEqual({ changed: [[2, 3]], deleted: [] });
});
test("many small blocks do not require a quadratic diff table", () => {
  const before = Array.from({ length: 10000 }, (_, i) => `Block ${i}`).join("\n");
  const blocks = Array.from({ length: 10000 }, (_, i) => ({ sourceRange: [i, i + 1] satisfies [number, number] }));
  expect(diffSourceBlocks(before, blocks, before.replace("Block 5000\n", "Edited 5000\n"), blocks)).toEqual({ changed: [[5000, 5001]], deleted: [] });
});

test("changed reference definitions mark the block whose rendered link changed", async () => {
  const before = "# Same\n\nA [reference][target].\n\nUnchanged.\n\n[target]: https://before.example\n";
  expect(await calculateBlockChanges(before, before.replace("before.example", "after.example"), null))
    .toEqual({ changed: [[2, 3]], deleted: [] });
});

test("baseline blocks are reused until their generation changes", async () => {
  const { BlockChangeCalculator } = await import("../src/main/block-changes");
  const { createWorkerRenderCore } = await import("../src/main/markdown");
  const core = createWorkerRenderCore(); let baselineRenders = 0;
  const calculator = new BlockChangeCalculator(async (...args) => { if (args[0] === "Baseline") baselineRenders++; return core.renderBlocks(...args); });
  expect((await calculator.calculate("Baseline", "Edit", null, "doc:1")).changed).toEqual([[0, 1]]);
  await calculator.calculate("Baseline", "Another edit", null, "doc:1");
  expect(baselineRenders).toBe(1);
  await calculator.calculate("Baseline", "Third edit", null, "doc:2");
  expect(baselineRenders).toBe(2);
});
test("large documents skip change rendering with a quiet status note", async () => {
  const { calculateBlockChanges } = await import("../src/main/block-changes");
  expect(await calculateBlockChanges("Small", "x".repeat(2 * 1024 * 1024 + 1), null)).toEqual({ changed: [], deleted: [], note: "Change highlights are off above 2 MB." });
});


test("lists report individual changed lines, including nested items", async () => {
  const before = "# Plan\n\n- One\n- Two\n  - Nested\n- Three\n";
  expect(await calculateBlockChanges(before, before.replace("Two", "Revised"), null)).toEqual({ changed: [[3, 4]], deleted: [] });
  expect(await calculateBlockChanges(before, before.replace("Nested", "Changed nested"), null)).toEqual({ changed: [[4, 5]], deleted: [] });
  expect(await calculateBlockChanges(before, before.replace("- Two\n", "- New\n- Two\n"), null)).toEqual({ changed: [[3, 4]], deleted: [] });
});


test("reference changes still mark a list whose source text stayed unchanged", async () => {
  const source = "- [Link][target]\n\n[target]: https://before.example\n";
  expect((await calculateBlockChanges(source, source.replace("before", "after"), null)).changed).toEqual([[0, 1]]);
});

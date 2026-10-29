import { expect, test } from "bun:test";
import { calculateBlockChanges, diffSourceBlocks } from "../src/main/block-changes";

test("insertion leaves following blocks unchanged", async () => {
  expect(await calculateBlockChanges("# Title\n\nOne\n\nTwo", "# Title\n\nNew\n\nOne\n\nTwo", null))
    .toEqual({ changed: [[2, 3]], deleted: [] });
});
test("deletion marks the following boundary and the end of an empty document", async () => {
  expect(await calculateBlockChanges("# Title\n\nOne\n\nTwo", "# Title\n\nTwo", null))
    .toEqual({ changed: [], deleted: [2] });
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

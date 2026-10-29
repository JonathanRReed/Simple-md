import { findMdxRanges } from "../src/shared/mdx-ranges";
import { describe, expect, test } from "bun:test";
import { toggleTaskAt } from "../src/renderer/tasks";

describe("toggleTaskAt", () => {
  test("checks and unchecks by ordinal across mixed list styles", () => {
    const src = "- [ ] a\n\n1. [x] b\n\n  * [X] c\n";
    expect(toggleTaskAt(src, 0)).toBe("- [x] a\n\n1. [x] b\n\n  * [X] c\n");
    expect(toggleTaskAt(src, 1)).toBe("- [ ] a\n\n1. [ ] b\n\n  * [X] c\n");
    // Unchecking an uppercase marker normalizes to a space; checking always writes "x".
    expect(toggleTaskAt(src, 2)).toBe("- [ ] a\n\n1. [x] b\n\n  * [ ] c\n");
  });

  test("returns null when the ordinal is out of range and never touches text", () => {
    const src = "- [ ] only\n";
    expect(toggleTaskAt(src, 1)).toBeNull();
    expect(toggleTaskAt("- not a task [ ]\n", 0)).toBeNull();
  });
});

test("task ordinals exclude fenced and indented code, frontmatter, and bare markers", () => {
  const src = "---\n- [ ] metadata\n---\n\n```md\n- [ ] example\n```\n\n    - [ ] indented\n\n- [ ]\n\n- [ ] actual\n";
  expect(toggleTaskAt(src, 0)).toBe(src.replace("[ ] actual", "[x] actual"));
  expect(toggleTaskAt(src, 1)).toBeNull();
});

test("quoted, nested, and parenthesized ordered tasks use rendered order", () => {
  const src = "> - [ ] quoted\n\n1) [x] ordered\n   - [ ] nested\n";
  expect(toggleTaskAt(src, 0)).toBe(src.replace("[ ] quoted", "[x] quoted"));
  expect(toggleTaskAt(src, 1)).toBe(src.replace("[x] ordered", "[ ] ordered"));
  expect(toggleTaskAt(src, 2)).toBe(src.replace("[ ] nested", "[x] nested"));
});

test("CRLF task toggling preserves original line endings", () => {
  expect(toggleTaskAt("- [ ] first\r\n- [x] next\r\n", 1)).toBe("- [ ] first\r\n- [ ] next\r\n");
});

test("task toggling changes only the marker with BOM, mixed endings, lone CR and no final newline", () => {
  for (const src of [
    "\uFEFF- [ ] first\r\n- [X] next\r- [ ] last",
    "---\rtitle: example\r---\r- [ ] first\r- [X] next\r- [ ] last",
  ]) {
    expect(toggleTaskAt(src, 1)).toBe(src.replace("[X] next", "[ ] next"));
    expect(toggleTaskAt(src, 2)).toBe(src.replace("[ ] last", "[x] last"));
  }
});

test("every rendered footnote checkbox maps to its exact source marker", async () => {
  const { renderBlocks } = await import("../src/main/markdown");
  const fixtures = [
    {
      source: "Reference[^n].\n\n[^n]: - [ ] footnote-task\n\n- [ ] ordinary-task\n",
      order: ["ordinary-task", "footnote-task"],
    },
    {
      source: "Second[^b], then first[^a].\n\n[^a]: - [ ] first-footnote\n      - [ ] nested-footnote\n\n[^b]: - [ ] second-footnote\n\n> - [ ] ordinary-quote\n",
      order: ["ordinary-quote", "second-footnote", "first-footnote", "nested-footnote"],
    },
  ];
  for (const { source, order } of fixtures) {
    const { blocks } = await renderBlocks(source, "/tmp/tasks.md");
    const html = blocks.map((block) => block.html).join("");
    expect([...html.matchAll(/class="task-list-item-checkbox"/g)]).toHaveLength(order.length);
    let previous = -1;
    for (const [ordinal, label] of order.entries()) {
      const position = html.indexOf(label);
      expect(position).toBeGreaterThan(previous);
      previous = position;
      expect(toggleTaskAt(source, ordinal)).toBe(source.replace(`[ ] ${label}`, `[x] ${label}`));
    }
    expect(toggleTaskAt(source, order.length)).toBeNull();
  }
});

test("rendered task ordinals exclude display math and alert bodies use the same parser", async () => {
  const { renderBlocks } = await import("../src/main/markdown");
  for (const source of [
    "$$\n- [ ] math-only\n$$\n\n- [ ] actual\n",
    "$$\n\\begin{aligned}\n- [ ] math-only\n\\end{aligned}\n$$\n\n> [!NOTE]\n> - [ ] actual\n",
  ]) {
    const html = (await renderBlocks(source, "/tmp/tasks.md")).blocks.map(block => block.html).join("");
    expect([...html.matchAll(/class=\"task-list-item-checkbox\"/g)]).toHaveLength(1);
    expect(toggleTaskAt(source, 0)).toBe(source.replace("[ ] actual", "[x] actual"));
    expect(toggleTaskAt(source, 1)).toBeNull();
  }
});


test("MDX tasks skip inert ESM and expressions and include component children", () => {
  const text = 'export const data = `\n\n- [ ] hidden\n\n`\n\n<Card>\n- [ ] child\n</Card>\n\n- [ ] outside';
  const ranges = findMdxRanges(text);
  expect(ranges.error).toBeUndefined();
  expect(toggleTaskAt(text, 0, ranges)).toBe(text.replace('[ ] child', '[x] child'));
  expect(toggleTaskAt(text, 1, ranges)).toBe(text.replace('[ ] outside', '[x] outside'));
});

import { expect, test } from "bun:test";
import { blockEdit, type BlockCommand } from "../src/renderer/block-commands";
import { rowCells, tableEdit } from "../src/renderer/table-source";
import { applySourceChanges } from "../src/renderer/source-edit";
const run = (text: string, cmd: BlockCommand, from = 0, to = text.length) => applySourceChanges(text, blockEdit(text, { from, to }, cmd, true).changes);
for (const eol of ["\n", "\r\n"]) {
  const lines = (...parts: string[]) => parts.join(eol);
  test(`blank lines and continuation lines stay intact ${JSON.stringify(eol)}`, () => {
    for (const [cmd, marker] of [["bullet-list", "- "], ["task-list", "- [ ] "], ["heading-2", "## "], ["quote", "> "]] satisfies [BlockCommand, string][]) {
      expect(run(lines("Alpha", "", "Beta", ""), cmd)).toBe(lines(marker + "Alpha", "", marker + "Beta", ""));
      expect(run(lines("- first", "  continued", "- second", ""), cmd)).toBe(lines(cmd === "quote" ? "> - first" : cmd === "bullet-list" ? "first" : marker + "first", "  continued", cmd === "quote" ? "> - second" : cmd === "bullet-list" ? "second" : marker + "second", ""));
    }
    expect(run(lines("- first", "  continued", "- second", ""), "number-list")).toBe(lines("1. first", "  continued", "2. second", ""));
  });
  test(`fences stay in their container ${JSON.stringify(eol)}`, () => {
    for (const prefix of ["> ", "  ", ">   "]) {
      const text = lines(prefix + "intro", prefix + "code line", prefix + "outro", "");
      const at = text.indexOf("code line");
      expect(run(text, "code-block", at, at + 9)).toBe(lines(prefix + "intro", prefix + "```", prefix + "code line", prefix + "```", prefix + "outro", ""));
    }
    const text = lines("- item", "", "  code line", "- next", "");
    const at = text.indexOf("code line");
    expect(run(text, "code-block", at, at + 9)).toBe(lines("- item", "", "  ```", "  code line", "  ```", "- next", ""));
    expect(run(lines("> one", "two"), "code-block")).toBe(lines("> one", "two"));
  });
  test(`heading commands absorb a setext underline ${JSON.stringify(eol)}`, () => {
    expect(run(lines("Title", "=====", "", "Body text", ""), "heading-2")).toBe(lines("## Title", "", "## Body text", ""));
    expect(run(lines("Title", "-----", "next", ""), "heading-3", 0, 5)).toBe(lines("### Title", "next", ""));
    expect(run(lines("Title", "====="), "body")).toBe("Title");
    // A rule after a blank line, and dashes under a list item, are not underlines.
    expect(run(lines("Para", "", "---", ""), "heading-1", 0, 4)).toBe(lines("# Para", "", "---", ""));
    expect(run(lines("- item", "---", ""), "heading-1", 0, 6)).toBe(lines("# item", "---", ""));
  });
  test(`rules only insert separated lines ${JSON.stringify(eol)}`, () => {
    expect(run(lines("A paragraph", ""), "rule", 11 + eol.length, 11 + eol.length)).toBe(lines("A paragraph", "", "---", ""));
    const text = lines("A paragraph", "", "next");
    expect(run(text, "rule", 11 + eol.length, 11 + eol.length)).toBe(lines("A paragraph", "", "---", "", "next"));
    expect(run(lines("***", "next"), "rule", 0, 0)).toBe(lines("***", "", "---", "", "next"));
  });
  test(`protected source stays unchanged ${JSON.stringify(eol)}`, () => {
    const text = lines("---", "title: x", "---", "", 'import X from "x";', "", "```", "- [ ] code", "```", "", "Body");
    for (const cmd of ["bullet-list", "number-list", "task-list", "heading-2", "quote", "body", "rule", "footnote", "toggle-task", "code-block"] satisfies BlockCommand[]) {
      for (const at of [0, text.indexOf("title"), text.indexOf("---", 3), text.indexOf("import"), text.indexOf("code")]) expect(run(text, cmd, at, at)).toBe(text);
    }
  });
  test(`GFM pipes split even inside code spans ${JSON.stringify(eol)}`, () => {
    expect(rowCells("| x | `a|b` | y |")).toHaveLength(4);
    expect(rowCells("| x | `a\\|b` | y |")).toHaveLength(3);
    for (const cell of ["`a|b`", "`a\\|b`"]) {
      const text = lines("| a | b | c | d |", "| - | - | - | - |", `| x | ${cell} | y |`);
      const at = text.indexOf("y |");
      const edit = tableEdit(text, { from: at, to: at }, "delete-column")!;
      expect(applySourceChanges(text, edit.changes)).not.toContain("y");
    }
  });
}

for (const eol of ["\n", "\r\n"]) test(`protected endpoints and YAML fences ${JSON.stringify(eol)}`, () => {
  const text = ['---', 'title: x', '- [ ] metadata', '```', 'yaml', '```', '...', '', 'Body', '', '```', 'code', '```'].join(eol);
  expect(run(text, 'toggle-task')).toBe(text);
  expect(run(text, 'code-block', text.indexOf('```'), text.indexOf('...') - eol.length)).toBe(text);
  expect(run(text, 'footnote', text.indexOf('Body'), text.indexOf('code') + 2)).toBe(text);
});

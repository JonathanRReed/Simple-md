import { expect, test } from "bun:test";
import { countProse, loadProseMdx } from "../src/shared/prose-count";
await loadProseMdx();
const cases: [string, string, number, number, boolean?][] = [
  ["plain", "One two", 2, 7],
  ["marks", "# **Hello** *world*", 2, 11],
  ["frontmatter", "---\r\ntitle: Not prose\r\n---\r\n\r\nHello world", 2, 11],
  ["fences", "Before\n\n```ts\nconst notProse = 1\n```\n\nAfter", 2, 12],
  ["indent code", "Hello\n\n    not prose\n\nBye", 2, 9],
  ["link destinations", "[Hello](https://example.test/long-url) world", 2, 11],
  ["imports and JSX", 'import Card from "./Card.astro";\n\n<Card title="Not prose">\n\nHello **world**\n\n</Card>', 2, 11, true],
  ["HTML tags", "Hello <em>kind</em> world", 3, 16],
  ["table", "| A | B |\n| --- | --- |\n| One | Two |", 4, 11],
  ["task and quote", "> - [x] Hello world", 2, 11],
  ["Unicode", "Café 你好 👋", 2, 9],
  ["inline code", "Say `hello`", 2, 9],
  ["incomplete JSX", "<Card title={\n\nHello", 0, 0, true],
];
for (const [name, text, words, characters, mdx] of cases) test(name, () => {
  expect(countProse(text, undefined, mdx).document).toEqual({ words, characters });
});
test("selection uses original parser ranges, including selections inside code and YAML", () => {
  const text = "---\ntitle: Ignore\n---\n\nHello **world**\n\n```\nignore\n```";
  const from = text.indexOf("world");
  expect(countProse(text, { from, to: from + 5 }).selection).toEqual({ words: 1, characters: 5 });
  const code = text.lastIndexOf("ignore");
  expect(countProse(text, { from: code, to: code + 6 }).selection).toEqual({ words: 0, characters: 0 });
  expect(countProse(text, { from: 5, to: 16 }).selection).toEqual({ words: 0, characters: 0 });
  expect(countProse(text, { from: 0, to: 0 }).selection).toBeUndefined();
});
test("reading time counts prose at 230 words per minute", () => {
  expect(countProse("word ".repeat(461)).minutes).toBe(3);
});
for (const [name, text, words, characters, mdx] of [
  ["adjacent emphasis", "hel**lo**", 1, 5],
  ["escaped punctuation", "Hello \\*world\\*", 2, 13],
  ["entity", "One &amp; two", 2, 9],
  ["HTML blocks", "<div><p>One</p><p>Two</p></div>", 2, 7],
  ["inert HTML", "<script>not prose</script>\n\nHello", 1, 5],
  ["BOM", "\uFEFFHello world\r\n", 2, 11],
  ["BOM heading", "\uFEFF# Hello", 1, 5],
  ["MDX expressions", "Hello {name} world", 2, 11, true],
  ["MDX attributes", '<Thing title="Not prose" value={42}>Hello</Thing>', 1, 5, true],
  ["nested MDX", "<Card>\n\n# Hello\n\n<Inner>world</Inner>\n\n</Card>", 2, 11, true],
] satisfies [string, string, number, number, boolean?][]) test(name, () => {
  expect(countProse(text, undefined, mdx).document).toEqual({ words, characters });
});

test("rendered selection counts literal prose without reparsing it as Markdown", () => {
  expect(countProse("First **words** and more", undefined, false, "*literal*").selection).toEqual({ words: 1, characters: 9 });
  expect(countProse("Document", undefined, false, "").selection).toBeUndefined();
});

test("reference-link labels are destinations rather than prose", () => {
  expect(countProse("[Hello][site] world\n\n[site]: https://example.test").document).toEqual({ words: 2, characters: 11 });
});

test("footnote labels use the same approximate Markdown count as other prose", () => {
  const text = "Hello[^1].\n\n[^1]: First **note**.\n\n    Second paragraph.";
  expect(countProse(text).document).toEqual({ words: 5, characters: 24 });
  expect(countProse(text, { from: 5, to: 9 }).selection).toEqual({ words: 1, characters: 2 });
});

test("plain Markdown is counted without loading the MDX parser", async () => {
  const script = `import { countProse } from ${JSON.stringify(new URL("../src/shared/prose-count.ts", import.meta.url).href)};
    const count = countProse("# Title\\n\\nTwo words").document;
    let refused = false;
    try { countProse("<Note>text</Note>", undefined, true); } catch { refused = true; }
    process.stdout.write(JSON.stringify({ count, refused }));`;
  const child = Bun.spawnSync([process.execPath, "-e", script]);
  expect(JSON.parse(child.stdout.toString())).toEqual({ count: { words: 3, characters: 15 }, refused: true });
});

test("emoji and other astral characters count once each", () => {
  expect(countProse("Hi 👋🏽 there").document).toEqual({ words: 2, characters: [..."Hi 👋🏽 there"].length });
  expect(countProse("﻿---\ntitle: x\n---\n\n𝒜 and 𝒷").document).toEqual({ words: 3, characters: 7 });
});

test("a caret move within one revision does not ask for another count", async () => {
  const { createProseCounter } = await import("../src/renderer/prose-counter");
  const output = { textContent: "", title: "" } as HTMLElement;
  let requests = 0, selection: { from: number; to: number } | undefined;
  let key = "1:1:false";
  const counter = createProseCounter(output, () => ({ key, text: "One two", mdx: false, selection }), async source => {
    requests++;
    return countProse(source.text, source.selection, source.mdx);
  });
  const settle = async () => { counter.schedule(); await Bun.sleep(450); };
  await settle(); expect(requests).toBe(1); expect(output.textContent).toContain("2 words");
  selection = { from: 3, to: 3 }; await settle(); expect(requests).toBe(1);
  selection = { from: 0, to: 3 }; await settle(); expect(requests).toBe(2); expect(output.textContent).toContain("selected");
  selection = undefined; await settle(); expect(requests).toBe(2); expect(output.textContent).not.toContain("selected");
  key = "1:2:false"; await settle(); expect(requests).toBe(3);
  counter.destroy();
});

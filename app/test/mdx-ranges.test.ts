import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { findMdxRanges, type MdxRanges } from "../src/shared/mdx-ranges";

const fixture = readFileSync(new URL("./fixtures/mdx-editing.mdx", import.meta.url), "utf8");

function reconstruct(source: string, ranges: MdxRanges): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.end).toBeGreaterThan(range.start);
    expect(range.end).toBeLessThanOrEqual(source.length);
    for (const span of range.syntax) {
      expect(span.start).toBeGreaterThanOrEqual(range.start);
      expect(span.end).toBeLessThanOrEqual(range.end);
      expect(span.end).toBeGreaterThan(span.start);
    }
    if (range.end <= cursor) continue;
    parts.push(source.slice(cursor, Math.max(cursor, range.start)));
    parts.push(source.slice(Math.max(cursor, range.start), range.end));
    cursor = range.end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

describe("findMdxRanges", () => {
  test("parses a synthetic Astro post without executing or removing its source", () => {
    const ranges = findMdxRanges(fixture);
    expect(ranges.error).toBeUndefined();
    expect(new Set(ranges.map((range) => range.kind))).toEqual(new Set([
      "esm", "jsx-flow", "jsx-text", "expression-flow", "expression-text", "mdx-comment",
    ]));
    expect(reconstruct(fixture, ranges)).toBe(fixture);
    const article = ranges.find((range) => "name" in range && range.name === "Article");
    expect(article).toBeDefined();
    expect(fixture.slice(article!.start, article!.end)).toContain("## Markdown inside a component");
    expect(ranges.filter((range) => "name" in range).map((range) => [range.name, range.capitalized])).toEqual([
      ["Badge", true], ["Article", true], ["Chart.Frame", true], ["Chart", true], ["style", false], ["script", false],
    ]);
    expect("__simplemdMdxExecuted" in globalThis).toBe(false);
    expect(ranges.some((range) => fixture.slice(range.start, range.end).includes("import Example"))).toBe(false);
  });

  test("ESM includes multiline imports and exports at their exact positions", () => {
    const source = 'import {\n  A, B\n} from "module";\n\nexport const x = { value: 1 };\n\nbody';
    const ranges = findMdxRanges(source);
    expect(ranges.error).toBeUndefined();
    expect(ranges.map((range) => [range.kind, source.slice(range.start, range.end), range.startLine, range.endLine])).toEqual([
      ["esm", 'import {\n  A, B\n} from "module";', 1, 3],
      ["esm", "export const x = { value: 1 };", 5, 5],
    ]);
  });

  test("tag and attribute names and attribute expressions come from tokens", () => {
    const source = '<UI.Card className="wide" aria-label="x" value={{a: ">"}} {...props} />';
    const ranges = findMdxRanges(source);
    expect(ranges.error).toBeUndefined();
    expect(ranges[0]?.syntax.map((span) => [span.kind, source.slice(span.start, span.end)])).toEqual([
      ["tag-name", "UI.Card"], ["attribute", "className"], ["attribute", "aria-label"],
      ["attribute", "value"], ["expression", '{{a: ">"}}'], ["expression", "{...props}"],
    ]);
  });

  test("nested components, lowercase HTML, and fragments have complete element ranges", () => {
    const source = '<>\n\n<Outer>\n\n<Inner />\n\nText <span>hi</span>.\n\n</Outer>\n\n</>';
    const ranges = findMdxRanges(source);
    expect(ranges.error).toBeUndefined();
    expect(ranges.filter((range) => "name" in range).map((range) => range.name)).toEqual([null, "Outer", "Inner", "span"]);
    expect(ranges[0]?.end).toBe(source.length);
    expect(reconstruct(source, ranges)).toBe(source);
  });

  test("frontmatter, inline code, and backtick and tilde fences are not MDX", () => {
    const source = '---\ntitle: "<Fake /> {broken"\n---\n\n`<Inline /> {broken`\n\n````mdx\nimport A from "a"\n```\n<A />\n````\n\n~~~mdx\n<Other />\n{broken\n~~~\n\n<Real />';
    const ranges = findMdxRanges(source);
    expect(ranges.error).toBeUndefined();
    expect(ranges.map((range) => source.slice(range.start, range.end))).toEqual(["<Real />"]);
  });

  test("comments preserve content and do not confuse strings, code, or JSX attributes", () => {
    const source = '<!-- hi\n<Fake /> {broken --> after <B />\n\n{/* block */ /* next */}\n\ninline {/* text */} end\n\n<X title="<!-- literal -->" value={"<!-- string -->"} />\n\n`<!-- code -->`';
    const ranges = findMdxRanges(source);
    expect(ranges.error).toBeUndefined();
    expect(ranges.filter((range) => range.kind === "mdx-comment").map((range) => source.slice(range.start, range.end))).toEqual([
      "<!-- hi\n<Fake /> {broken -->", "{/* block */ /* next */}", "{/* text */}",
    ]);
    expect(reconstruct(source, ranges)).toBe(source);
  });

  test("BOM, CRLF, bare CR, astral characters, and no final newline keep UTF-16 offsets", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      for (const prefix of ["", "\uFEFF", `\uFEFF---${newline}x: <Fake>${newline}---${newline}`]) {
        const source = `${prefix}import X from "x"${newline}${newline}😀 <X className="x" />`;
        const ranges = findMdxRanges(source);
        expect(ranges.error).toBeUndefined();
        expect(ranges[0]?.start).toBe(prefix.length);
        expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('import X from "x"');
        const tag = ranges.at(-1)!;
        expect(tag.start).toBe(source.indexOf('<X className'));
        expect(tag.end).toBe(source.length);
        expect(tag.startLine).toBe(prefix.includes("---") ? 6 : 3);
        expect(reconstruct(source, ranges)).toBe(source);
      }
    }
  });

  test("invalid and incomplete input returns completed ranges and an escaped-source error span", () => {
    const prefix = 'import X from "x"\n\n<X />\n\n';
    for (const invalid of ["<Unclosed>", "<A", "<A value={", "<A>\n\n</B>", "{broken", "{1 + }", 'export const = "bad"', "<!-- incomplete"]) {
      const source = prefix + invalid;
      const ranges = findMdxRanges(source);
      expect(ranges.error).toBeDefined();
      expect(ranges.error!.start).toBeGreaterThanOrEqual(prefix.length);
      expect(ranges.error!.end).toBe(source.length);
      expect(ranges.error!.offset).toBeGreaterThanOrEqual(ranges.error!.start);
      expect(ranges.error!.line).toBeGreaterThanOrEqual(5);
      expect(ranges.slice(0, 2).map((range) => range.kind)).toEqual(["esm", "jsx-flow"]);
      expect(reconstruct(source, ranges)).toBe(source);
    }
    const inline = findMdxRanges("ok <B /> then {bad");
    expect(inline[0]?.kind).toBe("jsx-text");
    expect(inline.error?.start).toBe(14);
  });

  test("truncated input never throws", () => {
    const source = 'import X from "x"\n\n<A value={{ a: 1 }}>\n\ntext <B /> and {2 + 3}\n\n</A>\n\n<!-- hi -->';
    for (let i = 0; i <= source.length; i++) expect(() => findMdxRanges(source.slice(0, i))).not.toThrow();
  });

  test("reports full parsing time for a 100k-character document", () => {
    const section = '<Card className="post">\n\n## Heading\n\nA paragraph with **Markdown** and <Badge value={3} />.\n\n</Card>\n\n';
    const count = Math.floor(100_000 / section.length);
    const source = section.repeat(count).padEnd(100_000, " ");
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      const ranges = findMdxRanges(source);
      times.push(performance.now() - start);
      expect(ranges.error).toBeUndefined();
      expect(ranges).toHaveLength(count * 2);
      expect(reconstruct(source, ranges)).toBe(source);
    }
    const warm = times.slice(1).sort((a, b) => a - b);
    console.info(JSON.stringify({ benchmark: "mdx-100k", characters: source.length, ranges: count * 2, coldMs: times[0], warmMedianMs: warm[2], warmMinMs: warm[0], warmMaxMs: warm.at(-1), warmRuns: warm.length }));
  });
});

const blogDirectory = process.env.SIMPLEMD_MDX_BLOG_DIR ?? "/Users/jonathanreed/Downloads/Personal-Site/src/content/blog";
test.skipIf(!existsSync(blogDirectory))("all owner blog posts parse without throws and reconstruct exactly", () => {
  const files = readdirSync(blogDirectory).filter((file) => file.endsWith(".mdx")).sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = readFileSync(`${blogDirectory}/${file}`, "utf8");
    const start = performance.now();
    const ranges = findMdxRanges(source);
    const ms = performance.now() - start;
    expect(ranges.error).toBeUndefined();
    expect(reconstruct(source, ranges)).toBe(source);
    console.info(JSON.stringify({ blog: file, characters: source.length, ranges: ranges.length, ms }));
  }
});

import path from "node:path";
import { expect, test } from "bun:test";
import { inlineMath, displayMathAt } from "../src/shared/github-math";
import { createMarkdownParser } from "../src/shared/markdown-parser";
import { documentThemes } from "../src/shared/themes";
import { contrast } from "../src/shared/theme-contrast";
import { paperSize } from "../src/shared/paper-size";
import { configSchema } from "../src/shared/config-schema";
import { parseConfig } from "../src/shared/config";
import { isTextFont } from "../src/shared/font-families";
import { quicklyDisplayPath } from "../src/main/open-quickly";
import { rankQuicklyFiles } from "../src/shared/open-quickly";
import { linkLocation } from "../src/shared/link-location";

const md = createMarkdownParser();
for (const raw of ["$x^2$", "$`x^2`$", "$$x^2$$"]) test(`Read and Live share extraction of ${raw}`, () => {
  expect(inlineMath(`Before ${raw} after`)).toEqual([{ from: 7, to: 7 + raw.length, raw, source: "x^2" }]);
  const tokens = md.parse(`Before ${raw} after`, {});
  expect(tokens.flatMap(t => t.children ?? []).filter(t => t.type === "math_inline").map(t => t.content)).toEqual(["x^2"]);
});
test("math rejects escaped dollars, word interiors, blank display lines and trailing prose", () => {
  for (const text of ['\\$x$', '$x\\$', 'word$x$', '$x$word', '$ x $']) expect(inlineMath(text)).toEqual([]);
  for (const text of ['$$\nx\n\ny\n$$', '$$x$$\nprose', '$$\nx $$ y\n$$']) {
    const lines = text.split("\n");
    expect(displayMathAt(0, lines.length, n => lines[n]!)).toBeNull();
    expect(md.parse(text, {}).some(t => t.type === "math_block")).toBe(false);
  }
  const lines = ['$$', 'x^2', '$$', ''];
  expect(displayMathAt(0, lines.length, n => lines[n]!)).toEqual({ end: 2, source: "x^2" });
});
const mix = (a: string, b: string, weight: number) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * weight + parseInt(b.slice(i, i + 2), 16) * (1 - weight)).toString(16).padStart(2, '0')).join('');
for (const theme of documentThemes) test(`${theme.id}: MDX and alert titles meet 4.5:1 in both reading styles`, async () => {
  const syntax = await Bun.file(new URL('../src/renderer/mdx-syntax.ts', import.meta.url)).text();
  expect(syntax).not.toContain('&dark');
  for (const token of ['keyword', 'string', 'name', 'type', 'comment'] as const) {
    expect(syntax).toContain(`var(--tok-${token})`);
    for (const background of [theme.background, theme.codeBackground]) expect(contrast(theme.syntax[token], background)).toBeGreaterThanOrEqual(4.5);
  }
  const css = await Bun.file(new URL('../src/renderer/style.css', import.meta.url)).text();
  expect(css).toContain('color: color-mix(in srgb, var(--fg) 35%, var(--alert))');
  for (const token of ['number', 'string', 'name', 'type', 'keyword'] as const) {
    const alert = theme.syntax[token];
    const text = mix(theme.foreground, alert, .35);
    const background = mix(alert, theme.background, .08);
    expect(contrast(text, background), `${token} on tinted background`).toBeGreaterThanOrEqual(4.5);
  }
});
test("paper size follows region with explicit overrides and one schema key", () => {
  expect(configSchema['paper-size'].options).toEqual(['auto', 'a4', 'letter']);
  expect(parseConfig('paper-size = letter').settings.paperSize).toBe('letter');
  for (const region of ['BZ', 'CA', 'CL', 'CO', 'CR', 'GT', 'MX', 'NI', 'PA', 'PH', 'PR', 'SV', 'US', 'VE']) expect(paperSize('auto', `en-${region}`)).toBe('Letter');
  for (const locale of ['en-GB', 'de-DE', 'ja-JP', 'en-AU', 'fr-FR', 'invalid_locale!']) expect(paperSize('auto', locale)).toBe('A4');
  expect(paperSize('a4', 'en-US')).toBe('A4');
  expect(paperSize('letter', 'en-GB')).toBe('Letter');
});
test("font choices exclude symbol, emoji and braille families without excluding text fonts", () => {
  for (const font of ['Apple Color Emoji', 'Apple Symbols', 'Symbol', 'Zapf Dingbats', 'Wingdings 2', 'Webdings', 'Apple Braille', 'LastResort', 'Segoe MDL2 Assets', 'Noto Sans Math']) expect(isTextFont(font), font).toBe(false);
  for (const font of ['New York', 'Charter', 'Noto Sans', 'Arial', 'Lexicon', 'STIX Two Text', 'ui-serif', 'SF Pro Text']) expect(isTextFont(font), font).toBe(true);
});
test("picker paths are repo relative or home abbreviated with correct highlight positions", () => {
  const home = path.resolve('/home/me'), repo = path.join(home, 'repo');
  expect(quicklyDisplayPath(path.join(repo, 'docs/plan.md'), repo, home)).toBe(path.join('docs', 'plan.md'));
  expect(quicklyDisplayPath(path.join(home, 'repo-other/plan.md'), repo, home)).toBe(path.join('~', 'repo-other', 'plan.md'));
  const elsewhere = path.resolve('/elsewhere/plan.md');
  expect(quicklyDisplayPath(elsewhere, repo, home)).toBe(elsewhere);
  const [file] = rankQuicklyFiles([{ path: '/home/me/repo/docs/plan.md', matchPath: 'docs/plan.md', displayPath: 'docs/plan.md', source: 'repo' }], 'docs');
  expect(file?.parent).toBe('docs');
  expect(file?.parentIndices).toEqual([0, 1, 2, 3]);
});
test("link locations retain decoded heading fragments for new tabs", () => {
  expect(linkLocation('./README.md#install%20here')).toEqual({ kind: 'heading', heading: 'install here' });
  expect(linkLocation('/blog/post/#section')).toEqual({ kind: 'heading', heading: 'section' });
  expect(linkLocation('./README.md')).toBeUndefined();
});

test("GitHub dollar-backtick math preserves TeX escaped dollars", () => {
  const raw = '$`\\sqrt{\\$4}`$';
  expect(inlineMath(raw)[0]?.source).toBe('\\sqrt{\\$4}');
  expect(md.parse(raw, {}).flatMap(t => t.children ?? []).find(t => t.type === "math_inline")?.content).toBe('\\sqrt{\\$4}');
});

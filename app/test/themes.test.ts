import { expect, test } from "bun:test";
import { documentThemes } from "../src/shared/themes";
import { configSchema } from "../src/shared/config-schema";
import { renderMarkdown } from "../src/main/markdown";
import { contrast } from "../src/shared/theme-contrast";
for (const theme of documentThemes) test(`${theme.label}: body, links, quotes, code, tables, selection and syntax meet AA`, () => {
  for (const background of [theme.background, theme.codeBackground, theme.tableBackground, theme.selectionTint]) {
    for (const foreground of [theme.foreground, theme.muted, theme.link]) {
      expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  // Extremes bound the luminance of the OS accent contribution to selection.
  for (const accent of ["#000000", "#ffffff", "#007aff", "#ffcc00"]) {
    const mixed = "#" + [1, 3, 5].map(start => Math.round(parseInt(accent.slice(start, start + 2), 16) * .12 + parseInt(theme.selectionTint.slice(start, start + 2), 16) * .88).toString(16).padStart(2, "0")).join("");
    expect(contrast(theme.foreground, mixed), `selected text on ${mixed}`).toBeGreaterThanOrEqual(4.5);
  }
  for (const foreground of Object.values(theme.syntax)) {
    for (const background of [theme.background, theme.codeBackground]) expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
});
test("theme schema choices all name token files with the right appearance", () => {
  for (const appearance of ["light", "dark"] as const) for (const id of configSchema[`theme-${appearance}`].options) {
    expect(documentThemes.find(theme => theme.id === id)?.appearance).toBe(appearance);
  }
});
test("Shiki emits semantic theme tokens, so changing palettes requires no parse or highlight", async () => {
  const rendered = await renderMarkdown('```typescript\nconst answer = "hello"; // comment\n```');
  expect(rendered.html).toContain("var(--smd-token-keyword)");
  expect(rendered.html).toContain("var(--smd-token-comment)");
  expect(rendered.html).toContain("var(--smd-token-string");
});

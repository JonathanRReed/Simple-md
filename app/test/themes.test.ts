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

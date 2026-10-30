import { expect, test } from "bun:test";
import { documentTitle, exportFilename } from "../src/shared/document-title";
import { createRenderCore } from "../src/shared/render-core";

test("document titles use metadata, then the first visible H1, then the filename", async () => {
  const core = createRenderCore();
  for (const [source, filename, expected] of [
    ['---\ntitle: "Trip notes"\n---\n# Other', "note.md", "Trip notes"],
    ['\uFEFF---\r\ntitle: Trip notes\r\n---\r\n# Other', "note.mdx", "Trip notes"],
    ['## Ignore\n\n# A **bold** [title](https://example.test) with `code`\n\n# Other', "note.md", "A bold title with code"],
    ['```md\n# Fenced\n```\n\n# Real', "note.md", "Real"],
    ['---\ntitle: >-\n  A folded\n  title\n---\n# Other', "note.md", "A folded title"],
    ['---\ntitle: ""\n---\n# Heading', "note.md", "Heading"],
    ['No heading', "some/file.md", "file"],
    ['No heading', null, "Untitled"],
  ] as const) {
    expect(await documentTitle(source, filename)).toBe(expected);
    expect((await core.renderBlocks(source, filename)).title).toBe(expected);
  }
});

test("export names preserve title punctuation and cannot create path components", () => {
  expect(exportFilename("Garden notes", "pdf")).toBe("Garden notes.pdf");
  expect(exportFilename("Version 1.2", "html")).toBe("Version 1.2.html");
  expect(exportFilename("../../unsafe: title?", "pdf")).toBe(".._.._unsafe_ title_.pdf");
  expect(exportFilename("...", "html")).toBe("Untitled.html");
});

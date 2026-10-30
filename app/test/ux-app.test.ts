import { expect, test } from "bun:test";
import path from "node:path";
import { renderBlocks } from "../src/main/markdown";
import { runDom } from "./dom-runner";

test("reader controls, scoped Find, palette and editor search work without visible windows", async () => {
  const text = "# Reader heading\n\nA test **repo** example. Test repo again.\n\n## Last section\n\nEnd.\n";
  const rendered = await renderBlocks(text, "/tmp/one/README.md");
  const result = await runDom(path.join(import.meta.dir, "renderer/ux-app.ts"), {
    text, rendered,
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text(),
  });
  expect(result).toEqual({ readFind: true, readerControls: true, deliberateEdit: true, palette: true, editorFind: true, settings: true });
}, 60_000);

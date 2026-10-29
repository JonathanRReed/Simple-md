import { expect, test } from "bun:test";
import path from "node:path";
import { createRenderCore } from "../src/shared/render-core";
import { runDom } from "./dom-runner";

test("sanitized pictures and fragment images follow app theme; HTML headings and footnotes remain navigable", async () => {
  const core = createRenderCore({ urls: () => ({ baseUrl: "file:///project/" }) });
  const source = '<picture><source media="(prefers-color-scheme: dark) and (min-width: 0px)" srcset="dark.svg"><source media="(prefers-color-scheme: light)" srcset="light.svg"><img src="fallback.svg"></picture>\n\n![dark](dark.svg#gh-dark-mode-only) ![light](light.svg#gh-light-mode-only)\n\n<h1>Raw <em>heading</em></h1>\n\n# Same\n\n<h2>Same</h2>\n\n# Same\n\nNote[^a], repeated[^a].\n\n[^a]: Footnote';
  const rendered = await core.renderMarkdown(source, "/project/note.md");
  const css = await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text();
  const results = await runDom(path.join(import.meta.dir, "github-fidelity/browser.ts"), [{ rendered, css }]);
  expect(results).toEqual([{
    selection: [
      { theme: "light", sources: [{ matches: false, original: "(prefers-color-scheme: dark) and (min-width: 0px)" }, { matches: true, original: "(prefers-color-scheme: light)" }], images: [false, true] },
      { theme: "dark", sources: [{ matches: true, original: "(prefers-color-scheme: dark) and (min-width: 0px)" }, { matches: false, original: "(prefers-color-scheme: light)" }], images: [true, false] },
    ],
    ids: ["user-content-raw-heading", "user-content-same", "user-content-same-1", "user-content-same-2", "user-content-footnote-label"],
    targets: ["Raw heading", "Same", "Same", "Same"],
    references: [
      { target: "user-content-fn-1", description: "Footnotes" }, { target: "user-content-fn-1", description: "Footnotes" },
      { target: "user-content-fnref-1", description: null }, { target: "user-content-fnref-1-2", description: null },
    ],
  }]);
}, 30_000);

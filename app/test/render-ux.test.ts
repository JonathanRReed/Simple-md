import { expect, test } from "bun:test";
import path from "node:path";
import { runDom } from "./dom-runner";
import { staticCss } from "../src/shared/static-assets";

test("images, metadata, labels, live HTML and closing tags in a hidden DOM", async () => {
  expect(staticCss).not.toContain(".titlebar");
  const css = await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text();
  const realPost = process.env.SIMPLEMD_UX_BLOG_FILE ? await Bun.file(process.env.SIMPLEMD_UX_BLOG_FILE).text() : undefined;
  const result = await runDom(path.join(import.meta.dir, "renderer/render-ux.ts"), { css, staticCss, realPost });
  expect(result).toEqual({ failures: [], images: 7, liveHtml: 16, typing: 6 });
}, 60_000);

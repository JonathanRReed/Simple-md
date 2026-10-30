import { expect, test } from "bun:test";
import path from "node:path";
import { runDom } from "./dom-runner";

const entry = path.join(import.meta.dir, "renderer/motion.ts");
async function inputs() {
  return {
    html: await Bun.file(path.join(import.meta.dir, "../src/renderer/index.html")).text(),
    css: await Bun.file(path.join(import.meta.dir, "../src/renderer/style.css")).text() + await Bun.file(path.join(import.meta.dir, "../src/renderer/motion.css")).text(),
  };
}
for (const reduced of [false, true]) test(`chrome motion preserves documents and respects reduced motion ${reduced}`, async () => {
  expect(await runDom(entry, { ...await inputs(), reduced }, { media: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] })).toEqual({ startup: true, tabs: true, pill: true, sidebar: true, split: true, panels: true, off: true, reduced });
}, 60_000);

if (process.env.SMD_MOTION_CAPTURES) test("capture chrome motion frames in hidden windows", async () => {
  for (const style of ["top", "sidebar"] as const) for (const capture of ["tab-add", "tab-close", "split", "split-axis", "split-close", "sidebar"]) {
    const directory = path.join(process.env.SMD_MOTION_CAPTURES!, style, capture);
    const result = await runDom(entry, { ...await inputs(), reduced: false, style, capture }, {
      media: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      screenshot: { path: path.join(directory, "done.png"), width: 1100, height: 760 },
      frames: { directory, times: [0, 40, 80, 120, 160, 240] },
    });
    expect(result).toMatchObject({ capture });
  }
}, 60_000);

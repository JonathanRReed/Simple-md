import { expect, test } from "bun:test";
import path from "node:path";

test("Live invalidation matches full recomputation through edits and selections without a DOM", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, "CorpusBrowser");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  try {
    // This existing oracle uses EditorState and decoration sets only. Its DOM wrapper is not imported.
    await import("./renderer/live-oracle");
    const browser = Reflect.get(globalThis, "CorpusBrowser") as { runBatch(fixtures: string[]): Promise<unknown> };
    const fixtures = await Promise.all(["small.md", "math.md", "fences.md", "astro.mdx"].map(name => Bun.file(path.join(import.meta.dir, "fixtures/perf", name)).text()));
    fixtures.push('![Logo][logo]\n\n| Link |\n| --- |\n| [Site][site] |\n\n[logo]: ./logo.png\n[site]: https://example.test\n\nBefore <code>$x$</code> after\n\n$`x^2`$ and $$y^2$$\n\nEnd');
    expect(await browser.runBatch(fixtures)).toEqual({ comparisons: fixtures.length * 450 + 1, failures: [] });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousBrowser) Object.defineProperty(globalThis, "CorpusBrowser", previousBrowser); else Reflect.deleteProperty(globalThis, "CorpusBrowser");
  }
});

import { expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import vm from "node:vm";
import { renderStaticHtml } from "../src/shared/render-browser";
import { runDom } from "./dom-runner";

const fixture = `# Quick Look

<details><summary>More</summary>

- [x] Task

> [!NOTE]
> Safe

Text[^a] and $x^2$.

[^a]: Footnote

~~~ts
const n = 1
~~~

~~~mermaid
graph LR
A-->B
~~~

![local](image.png)
![remote](https://evil.test/a.png)

<pre class="mermaid" data-evil="x" onclick="alert(1)">fake</pre>
<img src="https://evil.test/a.png"><video src="https://evil.test/a.mp4"></video>
<script>globalThis.pwned=true</script><style>body{display:none}</style>
</details>`;

test("standalone HTML preserves generated content and denies active/remote author content", async () => {
  const html = await renderStaticHtml(fixture, "/project/docs/README.md");
  const [result] = await runDom(path.join(import.meta.dir, "sanitizer/static-document-browser.ts"), [html]) as {
    csp: string; generated: Record<string, number>; hazards: string[]; local: string | null; mermaid: string | null; fonts: number;
  }[];
  expect(result!.csp).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data: file:; font-src data:");
  expect(result!.generated).toEqual({ shiki: 1, math: 1, checkbox: 1, alerts: 1, footnotes: 1, fake: 0, copyButtons: 0 });
  expect(result!.hazards).toEqual([]);
  expect(result!.local).toBe("file:///project/docs/image.png");
  expect(result!.mermaid).toBe("graph LR\nA-->B\n");
  expect(result!.fonts).toBe(20);
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).not.toContain("fonts/KaTeX");
}, 60_000);

test("static output supports MDX, file URLs, escaped paths and granted project roots", async () => {
  const html = await renderStaticHtml('<Card>\n\n**Safe** {run()}\n\n</Card>\n\n![local](../image.svg)\n\n<img src="/images/x.svg" />',
    "file:///project/space%20here/note.mdx", { urls: { rootUrl: "file:///project/" } });
  expect(html).toContain('class="mdx-component"');
  expect(html).toContain("<strong>Safe</strong>");
  expect(html).toContain("file:///project/image.svg");
  expect(html).toContain("file:///project/images/x.svg");
  const escaped = await renderStaticHtml('![x](a.png)', "/project/space # %/note.md");
  expect(escaped).toContain('src="file:///project/space%20%23%20%25/a.png"');
});

test("browser bundle runs with only ECMAScript built-ins and in Apple JavaScriptCore", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "simplemd-static-jsc-"));
  try {
    const bundle = path.join(temp, "render-core.js");
    const built = Bun.spawn([process.execPath, "build", path.join(import.meta.dir, "../src/shared/render-browser.ts"), "--target", "browser", "--format", "iife", "--minify", "--outfile", bundle], { stdout: "pipe", stderr: "pipe" });
    expect(await built.exited, await new Response(built.stderr).text()).toBe(0);
    const code = await Bun.file(bundle).text();
    const input = "# Bare context\n\n$x^2$\n\n~~~ts\nconst n = 1\n~~~\n\n![local](image.png)\n\n~~~mermaid\ngraph LR\nA-->B\n~~~\n\n<img src='javascript:alert(1)' onerror='alert(1)'>";
    const context = vm.createContext({});
    vm.runInContext(code, context);
    const call = `SimpleMDRenderCore.renderStaticHtml(${JSON.stringify(input)}, "/project/docs/note.md")`;
    const html: string = await vm.runInContext(call, context);
    expect(vm.runInContext("[typeof document, typeof window, typeof process, typeof Buffer, typeof fetch]", context).join(",")).toBe("undefined,undefined,undefined,undefined,undefined");
    expect(html).toContain('src="file:///project/docs/image.png"');
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain('--shiki-light:');
    expect(html).not.toMatch(/onerror=|javascript:/);
    if (process.platform === "darwin") {
      const script = path.join(temp, "test.js");
      await Bun.write(script, `load(${JSON.stringify(bundle)});\nif (typeof document !== "undefined" || typeof window !== "undefined" || typeof process !== "undefined") throw Error("Host API leaked");\n${call}.then(html => print(JSON.stringify({ html })), error => print(JSON.stringify({ error: String(error), stack: error.stack })));\n`);
      const child = Bun.spawn(["/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc", script], { stdout: "pipe", stderr: "pipe" });
      const [status, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(status, stderr).toBe(0);
      expect(JSON.parse(output)).toEqual({ html });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}, 60_000);

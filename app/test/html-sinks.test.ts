import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../src");
const approved = [
  // Only escaped Markdown and generated plugin HTML, with author units replaced
  // by DOM-time slots. No author strings may be passed to appFragment.
  "renderer/author-html.ts:template.innerHTML = html;",
  // KaTeX has trust:false. Source cannot produce links or arbitrary attributes.
  "renderer/live.ts:el.innerHTML = katex.renderToString(this.tex, { ...mathOptions, displayMode: false });",
  // Serialization of the sanitized print DOM. This is a getter, never insertion.
  "main/main.ts:return clone.innerHTML;",
].sort();

function sinks(directory: string, source?: string): string[] {
  const found: string[] = [];
  const files = source === undefined ? fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((name) => /\.[cm]?[jt]sx?$/.test(name)) : ["probe.ts"];
  for (const name of files) {
    const content = source ?? fs.readFileSync(path.join(directory, name), "utf8");
    for (const line of content.split("\n")) {
      if (/\b(?:innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|parseFromString|setHTMLUnsafe)\b/.test(line) && !/^\s*(?:\/\/|\*)/.test(line)) found.push(`${name.split(path.sep).join("/")}:${line.trim()}`);
    }
  }
  return found.sort();
}

test("every HTML parser or insertion in app source has an explicit owned path", () => {
  expect(sinks(root)).toEqual(approved);
});
test("the sink audit catches direct, computed and parser insertions", () => {
  for (const source of ['el.innerHTML = source;', 'el["outerHTML"] = source;', 'el.insertAdjacentHTML("beforeend", source);', 'new DOMParser().parseFromString(source, "text/html");', 'range.createContextualFragment(source);']) expect(sinks(root, source)).toHaveLength(1);
});

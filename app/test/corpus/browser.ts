import { mountRenderedHtml, updateFragments } from "../../src/renderer/author-html";
import type { RenderedHtml } from "../../src/shared/render-tree";
import { destroyDiagrams, renderDiagrams } from "../../src/renderer/diagrams";
import { compare, normalizeHtml, type Context } from "./normalize";

export interface ComparisonInput {
  id: string;
  expected: string;
  actual: string;
  rendered?: RenderedHtml;
  context: Omit<Context, "side" | "diagrams">;
}

export async function runBatch(inputs: ComparisonInput[]) {
  const results = [];
  for (const input of inputs) {
    if (input.rendered) {
      const safe = document.createElement("div");
      mountRenderedHtml(safe, input.rendered);
      updateFragments(safe);
      input.actual = safe.innerHTML;
    }
    const parsed = new DOMParser().parseFromString(input.actual, "text/html");
    const root = document.createElement("div");
    const sources: string[] = [];
    for (const pre of parsed.querySelectorAll("pre.mermaid")) {
      const copy = document.createElement("pre");
      copy.className = "mermaid";
      copy.textContent = pre.textContent;
      sources.push(copy.textContent ?? "");
      root.append(copy);
    }
    document.body.append(root);
    await renderDiagrams(root);
    const diagrams = sources.map((source, i) => {
      const holder = root.children[i];
      return { source, rendered: !!holder?.querySelector(".diagram-canvas svg") && !holder.querySelector('.diagram-error:not([hidden])') };
    });
    destroyDiagrams(root);
    root.remove();
    const expected = normalizeHtml(input.expected, { ...input.context, side: "github" });
    const actual = normalizeHtml(input.actual, { ...input.context, side: "simplemd", diagrams });
    results.push({ id: input.id, expected, actual, mismatches: compare(expected, actual) });
  }
  return results;
}

Object.assign(globalThis, { CorpusBrowser: { runBatch } });

import { mountRenderedHtml, sanitizeAuthorHtml, updateFragments } from "../../src/renderer/author-html";
import type { RenderedHtml } from "../../src/shared/render-tree";

interface Input { name: string; source: string; expected: string; rendered?: RenderedHtml; remoteImages?: boolean }
const urls = { baseUrl: "file:///project/docs/", rootUrl: "file:///project/public/" };
function canonical(node: Node): unknown {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node instanceof Element) return [node.namespaceURI, node.localName, [...node.attributes].map((a) => [a.name, a.value]).sort(([a], [b]) => a!.localeCompare(b!)), [...node.childNodes].map(canonical)];
  return [...node.childNodes].map(canonical);
}
async function runBatch(inputs: Input[]) {
  return inputs.map((input) => {
    const root = document.createElement("div");
    if (input.rendered) mountRenderedHtml(root, input.rendered, input.remoteImages);
    else root.append(sanitizeAuthorHtml(input.source, { urls, remoteImages: input.remoteImages }));
    updateFragments(root);
    const expected = document.createElement("template");
    expected.innerHTML = input.expected;
    return { generated: { shiki: root.querySelectorAll(".shiki").length, math: root.querySelectorAll(".katex").length,
      checkbox: root.querySelectorAll('input[type="checkbox"][disabled]').length, alerts: root.querySelectorAll(".markdown-alert").length,
      footnotes: root.querySelectorAll(".footnotes").length, diagrams: root.querySelectorAll("pre.mermaid").length,
      fake: root.querySelectorAll("[data-evil], [onclick], script, style").length }, name: input.name, actual: root.innerHTML, expected: input.expected, actualDom: [...root.childNodes].map(canonical), expectedDom: canonical(expected.content) };
  });
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

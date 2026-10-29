import { sanitizeAuthorHtml, mountRenderedHtml } from "../../src/renderer/author-html";
import type { RenderedHtml } from "../../src/shared/render-tree";

interface Input { name: string; source: string; staticHtml: string; rendered?: RenderedHtml; remoteImages?: boolean }
const urls = { baseUrl: "file:///project/docs/", rootUrl: "file:///project/" };
function canonical(node: Node): unknown {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node instanceof Element) return [node.namespaceURI, node.localName,
    [...node.attributes].map((a) => [a.name, a.value]).sort(([a], [b]) => a!.localeCompare(b!)), [...node.childNodes].map(canonical)];
  return [...node.childNodes].map(canonical);
}
function hazards(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const node of root.querySelectorAll("*")) {
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml") found.push("namespace");
    if (node.matches("script,style,iframe,template,noscript,svg,math,object,embed,form,input")) found.push(node.localName);
    for (const { name, value } of node.attributes) {
      if (/^on|^(?:style|class|is|data-.+|aria-.+)$/i.test(name)) found.push(name);
      if ((name === "id" || name === "name") && !value.startsWith("user-content-")) found.push("unprefixed " + name);
      if (/^(?:href|src|srcset|action|cite|itemtype|longdesc)$/.test(name) && /javascript:|vbscript:|data:/i.test(value.replace(/\s/g, ""))) found.push("URL");
    }
  }
  return found;
}
function runBatch(inputs: Input[]) {
  return inputs.map((input) => {
    const dom = document.createElement("div");
    if (input.rendered) mountRenderedHtml(dom, input.rendered, input.remoteImages);
    else dom.append(sanitizeAuthorHtml(input.source, { urls, remoteImages: input.remoteImages }));
    const output = document.createElement("div");
    // Test-only sink: exercise a real browser reparse of the static serializer.
    output.innerHTML = input.staticHtml;
    dom.normalize();
    output.normalize();
    return { name: input.name, actual: output.innerHTML, expected: dom.innerHTML,
      equal: JSON.stringify(canonical(output)) === JSON.stringify(canonical(dom)),
      hazards: input.rendered ? [] : [...hazards(output), ...hazards(dom)] };
  });
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

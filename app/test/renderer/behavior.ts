import { createEditor } from "../../src/renderer/editor";
import { destroyDiagrams, renderDiagrams } from "../../src/renderer/diagrams";
import type { RenderedHtml } from "../../src/shared/render-tree";

const waitFor = async (test: () => boolean) => {
  const until = performance.now() + 8000;
  while (!test()) {
    if (performance.now() > until) throw new Error("Renderer test timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
async function runBatch({ rendered, hashes }: { rendered: RenderedHtml; hashes: Record<string, number[]> }) {
  const parent = document.createElement("div");
  parent.style.cssText = "height:500px;width:600px;overflow:auto";
  document.body.append(parent);
  const editor = createEditor(parent, { text: "Start\n\n```ts\nconst answer = 42;\n```\n\n- [ ] Task\n\nEnd", mode: "live", host: {
    renderFragment: async () => rendered, baseUrl: () => "file:///tmp/", openLink() {},
  }, onChange() {}, onScroll() {}, onImages: async () => null });
  await waitFor(() => !!parent.querySelector(".shiki"));
  const code = parent.querySelector(".shiki");
  const view = (parent.querySelector(".cm-content") as HTMLElement & { cmTile: { root: { view: import("@codemirror/view").EditorView } } }).cmTile.root.view;
  view.dispatch({ changes: { from: 0, insert: "Before\n\n" }, selection: { anchor: view.state.doc.length + 8 } });
  await new Promise(resolve => setTimeout(resolve, 40));
  const reusedCode = parent.querySelector(".shiki") === code;
  const checkbox = parent.querySelector<HTMLInputElement>("input.cm-task")!;
  checkbox.click();
  const checkboxMapped = editor.getText().includes("- [x] Task");
  editor.destroy(); parent.remove();

  const observers: { nodes: Set<Element>; callback: IntersectionObserverCallback }[] = [];
  const OriginalObserver = window.IntersectionObserver;
  window.IntersectionObserver = class {
    nodes = new Set<Element>();
    constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
    observe(node: Element) { this.nodes.add(node); }
    unobserve(node: Element) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  } as unknown as typeof IntersectionObserver;
  const root = document.createElement("div"); document.body.append(root);
  const add = (source: string) => { const node = document.createElement("pre"); node.className = "mermaid"; node.textContent = source; root.append(node); return node; };
  // The blank-page DOM harness is not a secure context. Supply the same SHA-256
  // bytes computed in the parent, while the real file:// harness uses Web Crypto.
  if (!crypto.subtle) Object.defineProperty(crypto, "subtle", { value: {
    digest: async (_algorithm: AlgorithmIdentifier, data: BufferSource) => Uint8Array.from(hashes[new TextDecoder().decode(data)]!).buffer,
  } });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const releases: (() => void)[] = [];
  let started = 0;
  crypto.subtle.digest = async (algorithm, data) => {
    started++;
    await new Promise<void>(resolve => releases.push(resolve));
    return digest(algorithm, data);
  };
  for (let i = 0; i < 8; i++) add(`graph LR\n A${i}-->B${i}`);
  const oldReady = renderDiagrams(root);
  await Promise.resolve();
  const lazy = started === 0 && root.querySelectorAll("pre").length === 8;
  const observer = observers.at(-1)!;
  observer.callback([...observer.nodes].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver);
  const bounded = started === 2;
  destroyDiagrams(root);
  root.replaceChildren();
  const source = "graph LR\n A[Current]-->B[Only current]";
  add(source);
  const ready = renderDiagrams(root);
  observers.at(-1)!.callback([...observers.at(-1)!.nodes].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver);
  for (const release of releases.splice(0)) release();
  await waitFor(() => releases.length > 0);
  for (const release of releases.splice(0)) release();
  await Promise.all([oldReady, ready]);
  const stale = started === 3 && root.querySelectorAll(".diagram").length === 1 && !root.textContent?.includes("A0");
  const svg = !!root.querySelector("svg") && !root.querySelector("a,image,foreignObject,script,style");
  crypto.subtle.digest = digest;
  destroyDiagrams(root);
  // Print bypasses visibility and also exercises the cached SVG clone.
  document.body.classList.add("print");
  add(source);
  await renderDiagrams(root);
  const print = root.querySelectorAll("svg").length === 2;
  const ids = [...root.querySelectorAll("[id]")].map(node => node.id);
  const uniqueIds = ids.length === new Set(ids).size;
  destroyDiagrams(root); root.remove();
  document.body.classList.remove("print"); window.IntersectionObserver = OriginalObserver;
  return { reusedCode, checkboxMapped, lazy, bounded, stale, svg, print, uniqueIds };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

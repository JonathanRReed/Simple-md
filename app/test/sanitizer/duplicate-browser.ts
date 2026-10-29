import { sanitizeAuthorHtml } from "../../src/renderer/author-html";
Object.assign(globalThis, { CorpusBrowser: { runBatch(inputs: string[]) {
  return inputs.map(source => {
    const start = performance.now();
    const root = sanitizeAuthorHtml(source);
    return { elapsed: performance.now() - start, ids: [...root.querySelectorAll('[id]')].map(node => node.id) };
  });
} } });

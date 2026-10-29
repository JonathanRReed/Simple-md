import { mountRenderedHtml, updateFragments, fragmentTarget } from "../../src/renderer/author-html";
import { applyImageTheme } from "../../src/renderer/document-images";
import type { RenderedHtml } from "../../src/shared/render-tree";

interface Input { rendered: RenderedHtml; css: string }
async function runBatch(inputs: Input[]) {
  return inputs.map(({ rendered, css }) => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const root = document.createElement("div");
    mountRenderedHtml(root, rendered);
    updateFragments(root);
    document.body.append(root);
    const themes = ["light", "dark"] as const;
    const selection = themes.map((theme) => {
      document.documentElement.dataset.theme = theme;
      applyImageTheme(root, theme);
      return { theme,
        sources: [...root.querySelectorAll("source")].map((source) => ({ matches: matchMedia(source.media).matches, original: source.getAttribute("data-simplemd-media") })),
        images: [...root.querySelectorAll("img[src*='#gh-']")].map((image) => getComputedStyle(image).display !== "none"),
      };
    });
    const ids = [...root.querySelectorAll("h1,h2")].map((h) => h.id);
    const targets = ["#raw-heading", "#same", "#same-1", "#same-2"].map((fragment) => fragmentTarget(root, fragment)?.textContent);
    const references = [...root.querySelectorAll("a[data-footnote-ref], a[data-footnote-backref]")].map((link) => ({
      target: fragmentTarget(root, link.getAttribute("href")!)?.id,
      description: link.getAttribute("aria-describedby") ? root.querySelector(`[id="${link.getAttribute("aria-describedby")}"]`)?.textContent : null,
    }));
    root.remove();
    style.remove();
    return { selection, ids, targets, references };
  });
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

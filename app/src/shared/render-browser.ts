import { createRenderCore as createCore, type RenderServices } from "./render-core.js";
import { createHighlighter, bundledLanguages, type BundledLanguage, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { authorPolicy } from "./sanitizer-policy.js";
export { authorPolicy };
import { resolveAuthorUrl, resolveSrcset } from "./url-resolver.js";
export { resolveAuthorUrl, resolveSrcset };

let highlighter: Highlighter | undefined;
let loading: Promise<Highlighter> | undefined;
const themes = { light: "github-light", dark: "github-dark" } as const;
const highlighting: RenderServices = {
  async prepareHighlighting(tokens) {
    const wanted = [...new Set(tokens.filter((t) => t.type === "fence" && t.content.length <= 100_000)
      .map((t) => t.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
      .map((lang) => lang === "gitignore" ? "ini" : lang))]
      .filter((lang): lang is BundledLanguage => Object.hasOwn(bundledLanguages, lang));
    if (!wanted.length) return;
    loading ??= createHighlighter({ themes: Object.values(themes), langs: [], engine: createJavaScriptRegexEngine() });
    highlighter = await loading;
    const missing = wanted.filter((lang) => !highlighter!.getLoadedLanguages().includes(lang));
    if (missing.length) await highlighter.loadLanguage(...missing);
  },
  highlight(code, lang) {
    return highlighter?.getLoadedLanguages().includes(lang) ? highlighter.codeToHtml(code, { lang, themes, defaultColor: false }) : "";
  },
};
export function createRenderCore(services: RenderServices = {}) {
  return createCore({ ...highlighting, ...services });
}
const core = createRenderCore();
export const { renderMarkdown, renderBlocks, renderFragment } = core;

Object.assign(globalThis, { SimpleMDRenderCore: { ...core, createRenderCore, authorPolicy, resolveAuthorUrl, resolveSrcset } });

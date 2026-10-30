import { EditorView } from "@codemirror/view";
import { createPane } from "../../src/renderer/pane";
import { createEditor } from "../../src/renderer/editor";
import { openReadFind, closeReadFind } from "../../src/renderer/ui";
import { readSearchRanges } from "../../src/renderer/read-search";
import { createRenderCore, type RenderedBlocks } from "../../src/shared/render-core";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 120; i++) { if (check()) return; await pause(); }
  throw new Error(message);
}
export async function runBatch(input: { text: string; rendered: RenderedBlocks; toggled: RenderedBlocks; html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const base = document.createElement("base"); base.href = "file:///tmp/"; document.head.append(base);
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  applyDocumentStyle({ ...DEFAULT_SETTINGS, theme: "light" });
  document.documentElement.style.colorScheme = "light";
  const stage = document.querySelector<HTMLElement>("#stage")!; stage.dataset.panes = "2"; stage.dataset.axis = "horizontal";
  const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
  const root = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const other = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const el of root.querySelectorAll<HTMLElement>("[id]")) el.dataset.element = el.id;
  for (const el of other.querySelectorAll<HTMLElement>("[id]")) { el.dataset.element = el.id; el.removeAttribute("id"); }
  stage.append(root, other);
  let edits = 0, saved = 0, headReads = 0, headCommitted = false;
  const core = createRenderCore();
  let rejectFragment: (() => void) | undefined;
  let stallFragment = false;
  const api = {
    perfMarker() {}, documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {},
    edit() { edits++; },
    changes: async () => ({ kind: "head", generation: headReads, changes: headCommitted ? { changed: [], deleted: [] } : { changed: [[7, 8]], deleted: [] } }),
    headChanges: async () => { headReads++; return { available: true, active: true }; },
    renderBlocks: async (text: string) => text.includes("[x] Book") ? input.toggled : input.rendered,
    renderFragment: async (text: string) => {
      if (stallFragment && text.includes("const retry")) {
        stallFragment = false;
        return new Promise<Awaited<ReturnType<typeof core.renderFragment>>>((_resolve, reject) => { rejectFragment = () => reject(new Error("Stale document revision.")); });
      }
      return core.renderFragment(text, undefined);
    },
    save: async () => { saved++; return null; },
  };
  Object.assign(window, { simplemd: api });
  const pane = createPane(root, makePaneId(0), { active: () => true, changed() {}, tabs: () => [] });
  pane.settings({ ...DEFAULT_SETTINGS, autosave: false, outlineRail: false });
  await pane.load({ ...input.rendered, documentId: makeDocumentId(1), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: "/tmp/checks.md", name: "checks.md", baseUrl: "file:///tmp/", text: input.text, intent: "read" });
  const article = root.querySelector<HTMLElement>("#doc")!;
  const item = article.querySelector<HTMLElement>("li")!;
  item.click(); await pause(100);
  assert(edits === 0 && saved === 0 && pane.flush().text === input.text, "Clicking checklist text edited or saved the source");
  const box = item.querySelector<HTMLInputElement>("input")!;
  assert(!box.disabled && getComputedStyle(box).pointerEvents !== "none" && getComputedStyle(box).opacity === "1", "Checkbox has no enabled affordance");
  box.focus();
  const focusRule = [...style.sheet!.cssRules].find(rule => rule instanceof CSSStyleRule && rule.selectorText === ".prose .task-list-item-checkbox:focus");
  assert(document.activeElement === box && focusRule instanceof CSSStyleRule && focusRule.style.outline.includes("solid"), "Checkbox lacks focus or its focus ring rule");
  box.click(); await until(() => pane.flush().text.includes("[x] Book"), "Checkbox did not toggle");
  await until(() => !!article.querySelector<HTMLInputElement>("input")?.checked, "Rendered checkbox did not update");
  pane.command("undo"); await until(() => pane.flush().text === input.text, "Task toggle was not undoable");
  await pause(100);
  assert(saved === 0, "Autosave-off task changes were saved");
  const scroller = root.querySelector<HTMLElement>("#read-scroll")!; scroller.focus();
  assert(getComputedStyle(scroller).outlineStyle === "none", "Programmatic reader focus paints a page frame");
  const details = article.querySelector<HTMLDetailsElement>("details")!; assert(!details.open, "Metadata fixture was already open");
  openReadFind(article, () => {}, "seoTitle");
  assert(details.open && document.querySelector("#find-count")?.textContent === "1 of 1", "Find did not reveal collapsed metadata");
  const find = document.querySelector<HTMLElement>("#findbar")!;
  assert(find.parentElement === root, "Find is outside its document pane");
  const bounds = find.getBoundingClientRect(), paneBounds = root.getBoundingClientRect();
  assert(bounds.left >= paneBounds.left && bounds.right <= paneBounds.right + 1, `Find overlaps another pane: ${JSON.stringify({ bounds, paneBounds })}`);
  assert(readSearchRanges(article, "x2").length === 1, "Find counted both KaTeX representations");
  closeReadFind();
  await until(() => root.querySelector("#change-count")?.textContent === "1 change", "Initial HEAD changes missing");
  assert(article.querySelectorAll("li.change-highlight").length === 1 && !article.querySelector(".block.change-highlight"), "Change highlight covers the whole list");
  headCommitted = true; window.dispatchEvent(new Event("focus"));
  await until(() => headReads === 1 && root.querySelector<HTMLElement>("#changes")!.hidden, "Focus did not refresh the committed HEAD baseline");
  pane.command("mode-source"); await until(() => !!root.querySelector(".cm-content"), "Source editor missing"); await pause(100);
  const code = root.querySelector<HTMLElement>(".cm-code-font")!, inline = root.querySelector<HTMLElement>(".cm-code-font-inline")!;
  assert(code && inline && getComputedStyle(code).fontFamily === getComputedStyle(inline).fontFamily && /Mono|Menlo|monospace/i.test(getComputedStyle(code).fontFamily), "Source code does not use the code font");
  pane.command("mode-live"); await pause(100);
  const paneView = EditorView.findFromDOM(root.querySelector(".cm-editor")!)!;
  const retryFence = "\n\n```js\nconst retry = 1;\n```\n\nAfter";
  stallFragment = true;
  paneView.dispatch({ changes: { from: paneView.state.doc.length, insert: retryFence }, selection: { anchor: paneView.state.doc.length + retryFence.length } });
  await until(() => !!rejectFragment, "Fence did not begin its deferred render");
  paneView.dispatch({ changes: { from: 0, insert: "\n" } });
  rejectFragment!();
  await until(() => [...root.querySelectorAll(".cm-rendered-fence pre")].some(pre => pre.textContent?.includes("const retry")), "Stale fragment left a typed fence raw until remount");
  pane.suspend();

  const parent = document.createElement("div"); stage.append(parent);
  const host = { baseUrl: () => null, openLink() {}, renderFragment: (text: string) => core.renderFragment(text, undefined) };
  const commit = createEditor(parent, { text: "Subject\n\n# Comment, not a heading\n", filename: "/tmp/.git/COMMIT_EDITMSG", mode: "source", host, onChange() {}, onScroll() {}, onImages: async () => null });
  await pause(100); assert(!parent.querySelector(".tok-heading, .cm-heading"), "Git comments are styled as Markdown headings");
  commit.destroy(); parent.replaceChildren();
  const source = '<div align="center">\n\n[![inside](badge.svg)](https://example.test)\n\n</div>\n\n<p align="center"><a href="https://example.test"><img src="badge.svg" onerror="evil()"></a></p>\n\n[![badge](badge.svg)](https://example.test)\n\nEnd';
  const live = createEditor(parent, { text: source, mode: "live", host, onChange() {}, onScroll() {}, onImages: async () => null });
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
  view.dispatch({ selection: { anchor: source.length } });
  await until(() => parent.querySelectorAll(".cm-rendered img").length === 3, "Centered header or linked badge remained raw");
  assert(!parent.querySelector("[onerror]"), "Live HTML bypassed the author sanitizer");
  const fence = "\n\n```js\nconst typed = 1;\n```\n\nAfter";
  view.dispatch({ changes: { from: view.state.doc.length, insert: fence }, selection: { anchor: view.state.doc.length + fence.length } });
  await until(() => !!parent.querySelector(".cm-rendered-fence pre code"), "Incrementally typed fence remained raw");
  assert(!parent.querySelector(".cm-rendered-fence")!.textContent?.includes("```"), "Fence widget contains raw delimiters");
  live.destroy(); parent.remove();
  applyDocumentStyle({ ...DEFAULT_SETTINGS, readingFontFamily: "New York" });
  assert(document.documentElement.style.getPropertyValue("--reading-font").startsWith('"New York", ui-serif'), "New York lacks the system serif fallback");
  applyDocumentStyle({ ...DEFAULT_SETTINGS, readingFontFamily: "ui-serif" });
  assert(document.documentElement.style.getPropertyValue("--reading-font").startsWith("ui-serif,"), "System serif is quoted as an installed font name");
  return { checkbox: true, undo: true, find: true, math: true, scoped: true, head: true, codeFont: true, commit: true, live: true };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

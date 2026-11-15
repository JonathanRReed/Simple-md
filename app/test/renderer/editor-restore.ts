import { EditorView } from "@codemirror/view";
import { createPane } from "../../src/renderer/pane";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId, type Settings } from "../../src/shared/types";
import type { RenderedBlocks } from "../../src/shared/render-core";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}

export async function runBatch(input: { text: string; rendered: RenderedBlocks; html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  const settings: Settings = { ...DEFAULT_SETTINGS, autosave: false, outlineRail: false, uiMotion: "off" };
  applyDocumentStyle(settings);
  const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
  const root = template.content.firstElementChild!.cloneNode(true);
  assert(root instanceof HTMLElement, "Pane template missing");
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) element.dataset.element = element.id;
  const stage = document.querySelector<HTMLElement>("#stage")!; stage.dataset.panes = "1"; stage.append(root);
  Object.assign(window, { simplemd: {
    writingContext() {}, proseCounts: async () => ({ document: { words: 0, characters: 0 }, minutes: 1 }),
    menuCommands: async () => [], invokeMenu: async () => {}, perfMarker() {},
    documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {}, edit() {},
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: async () => input.rendered, renderFragment: async () => ({ html: "" }),
  } });
  const pane = createPane(root, makePaneId(0), { active: () => false, changed() {}, tabs: () => [] });
  pane.settings(settings);
  await pane.load({ ...input.rendered, documentId: makeDocumentId(1), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: "/tmp/restore.md", name: "restore.md", baseUrl: "file:///tmp/", text: input.text, intent: "read" });

  // Reproduce the browser's microtask checkpoint between two rAF callbacks:
  // CodeMirror's first measure completes, the reader scrolls, then pane entry
  // gets its callback. Keep real layout and CodeMirror measurement underneath.
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  let next = 1_000_000;
  const frames = new Map<number, FrameRequestCallback>();
  window.requestAnimationFrame = callback => { const id = ++next; frames.set(id, callback); return id; };
  window.cancelAnimationFrame = id => { if (!frames.delete(id)) cancel(id); };
  async function frame(): Promise<void> {
    const time = await new Promise<number>(resolve => request(resolve));
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) { callback(time); await Promise.resolve(); }
  }
  try {
    pane.command("mode-source");
    await until(() => !!root.querySelector(".cm-editor"), "Source editor did not mount");
    const view = EditorView.findFromDOM(root.querySelector(".cm-editor")!)!;
    let measured = false;
    view.requestMeasure({ read: () => undefined, write: () => {
      queueMicrotask(() => { view.scrollDOM.scrollTop = 500; measured = true; });
    } });
    for (let i = 0; i < 4; i++) await frame();
    assert(measured, "First editor measurement did not run");
    assert(view.scrollDOM.scrollTop === 500, "Pane entry restored a stale anchor after the reader scrolled");
    return { measured: true, scrolled: true };
  } finally {
    pane.suspend();
    window.requestAnimationFrame = request;
    window.cancelAnimationFrame = cancel;
  }
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

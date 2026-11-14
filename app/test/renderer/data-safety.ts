import { createPane } from "../../src/renderer/pane";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";
import type { RenderedBlocks } from "../../src/shared/render-core";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}
export async function runBatch(input: { scenario: string; text: string; incoming: string; rendered: RenderedBlocks; updated: RenderedBlocks; html: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
  const root = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) element.dataset.element = element.id;
  document.querySelector("#stage")!.append(root);
  Object.assign(window, { simplemd: {
    perfMarker() {}, documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {}, edit() {},
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: async (text: string) => text === input.incoming ? input.updated : input.rendered,
    acceptDisk: async () => true,
  } });
  const id = makeDocumentId(1), paneId = makePaneId(0);
  const pane = createPane(root, paneId, { active: () => true, changed() {}, tabs: () => [] });
  pane.settings({ ...DEFAULT_SETTINGS, autosave: false, mode: "source" });
  const payload = { ...input.rendered, documentId: id, paneId, revisionId: makeRevisionId(0), path: "/tmp/note.md", name: "note.md", baseUrl: "file:///tmp/", text: input.text, intent: "edit" as const };
  await pane.load(payload);
  const edit = async () => { pane.command("mode-source"); await until(() => !!root.querySelector(".cm-content"), "Editor did not mount"); await new Promise(resolve => setTimeout(resolve, 20)); };
  const read = async () => { pane.command("mode-read"); await until(() => root.dataset.view === "read", "Read did not mount"); };
  await read();
  const retained = pane.suspend();
  assert(retained.editor, "Test did not retain an editor");
  await pane.load(payload, retained);
  pane.diskChanged(input.incoming, id);
  await until(() => pane.flush().text === input.incoming, "Incoming text was not accepted");
  await edit();
  assert(pane.flush().text === input.incoming, "Retained editor replaced accepted disk bytes");
  pane.command("undo");
  assert(pane.flush().text === input.incoming, "Reload restored old undo history");
  await read();
  const after = pane.suspend();
  assert(after.state.readText === input.incoming, "Suspend retained old text");
  assert(!after.readBlocks.some(block => block.html.includes("Original")), "Suspend retained old read blocks");
  // A fresh load, including Back navigation, must discard all previous tab state.
  await pane.load({ ...payload, ...input.updated, text: input.incoming });
  await edit();
  assert(pane.flush().text === input.incoming, "Fresh load reused another source");
  pane.suspend();
  return true;
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

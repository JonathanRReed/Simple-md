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
  if (input.scenario.startsWith("missing")) {
    let attempt = 0;
    const requests: { text: string; saveAs: boolean; recreate: boolean }[] = [];
    Object.assign((window as unknown as { simplemd: object }).simplemd, { save: async (text: string, saveAs: boolean, _id: number, recreate = false) => {
      requests.push({ text, saveAs, recreate });
      if (++attempt === 1) return null;
      return { documentId: id, revisionId: pane.flush().revisionId, path: saveAs ? "/tmp/other.md" : payload.path, name: "note.md", baseUrl: payload.baseUrl, text };
    } });
    pane.diskChanged({ kind: "unavailable", message: "This file is missing or was moved." }, id);
    assert(pane.flush().dirty && pane.flush().conflict && pane.flush().unavailable, "Missing file did not retain a dirty buffer");
    assert(pane.flush().text === input.text, "Missing file changed the buffer");
    const banner = root.querySelector<HTMLElement>("[data-element=banner]")!;
    const buttons = [...banner.querySelectorAll("button")];
    assert(buttons.map(button => button.textContent).join(",") === "Recreate file,Save As…", "Recovery actions are missing");
    const button = buttons[input.scenario === "missing Save As" ? 1 : 0]!;
    button.click(); await until(() => !button.disabled, "Cancelled recovery stayed busy");
    assert(pane.flush().dirty && !banner.hidden, "Cancelled recovery discarded the buffer");
    button.click(); await until(() => !pane.flush().dirty, "Recovery did not accept the saved buffer");
    assert(requests.length === 2 && requests.every(request => request.text === input.text), "Recovery changed saved bytes");
    assert(requests.every(request => request.saveAs === (input.scenario === "missing Save As") && request.recreate === (input.scenario === "missing recreate")), "Recovery used the wrong save policy");
    assert(!pane.flush().conflict && !pane.flush().unavailable && banner.hidden, "Recovery left a missing-file conflict");
    pane.suspend(); return true;
  }
  if (input.scenario === "permissions") {
    const before = pane.flush();
    pane.diskChanged({ kind: "permissions", readOnlyReason: "This file is locked or not writable. Read only." }, id);
    assert(root.querySelector(".cm-content")?.getAttribute("contenteditable") === "false", "Read-only transition left editor writable");
    assert(pane.flush().text === before.text, "Permissions replaced the buffer");
    pane.diskChanged({ kind: "permissions" }, id);
    assert(root.querySelector(".cm-content")?.getAttribute("contenteditable") === "true", "Permission recovery left editor locked");
    assert(!pane.flush().conflict, "Permissions introduced a text conflict");
    pane.suspend(); return true;
  }
  if (input.scenario === "metadata notice") {
    const result = { documentId: id, revisionId: makeRevisionId(0), path: payload.path, name: payload.name, baseUrl: payload.baseUrl, text: input.text, metadataCopyFailed: true };
    pane.saved(result);
    const toast = document.querySelector<HTMLElement>("#toast")!;
    assert(toast.textContent?.includes("tags or extended attributes"), "Metadata warning is missing");
    toast.textContent = "cleared";
    pane.saved(result);
    assert(toast.textContent === "cleared", "Metadata warning repeated");
    const retained = pane.suspend();
    await pane.load(payload, retained);
    pane.saved(result);
    assert(toast.textContent === "cleared", "Metadata warning repeated after tab restore");
    pane.suspend(); return true;
  }
  const edit = async () => { pane.command("mode-source"); await until(() => !!root.querySelector(".cm-content"), "Editor did not mount"); await new Promise(resolve => setTimeout(resolve, 20)); };
  const read = async () => { pane.command("mode-read"); await until(() => root.dataset.view === "read", "Read did not mount"); };
  await read();
  const retained = pane.suspend();
  assert(retained.editor, "Test did not retain an editor");
  await pane.load(payload, retained);
  pane.diskChanged({ kind: "text", text: input.incoming }, id);
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

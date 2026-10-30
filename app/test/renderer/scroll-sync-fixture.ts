import { createPane } from "../../src/renderer/pane";
import { blockAnchor, restoreBlockAnchor } from "../../src/renderer/scroll-sync";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";
import type { RenderedBlocks } from "../../src/shared/render-core";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function settle() { await frame(); await frame(); await new Promise(resolve => setTimeout(resolve, 50)); }
async function until(fn: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}
export async function runBatch(input: { text: string; rendered: RenderedBlocks; html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  applyDocumentStyle(DEFAULT_SETTINGS);
  const root = document.querySelector<HTMLTemplateElement>("#pane-template")!.content.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const el of root.querySelectorAll<HTMLElement>("[id]")) el.dataset.element = el.id;
  const stage = document.querySelector<HTMLElement>("#stage")!; stage.dataset.panes = "1"; stage.append(root);
  const calls = { saves: [] as string[], drags: [] as string[], copies: [] as string[], opened: [] as string[] };
  let nextId = 0;
  const payload = (file: string, intent: "read" | "edit") => ({ ...input.rendered, documentId: makeDocumentId(++nextId), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: file, name: file.split("/").pop()!, baseUrl: "file:///tmp/", text: input.text, intent, initialMode: "source" as const });
  Object.assign(window, { simplemd: {
    perfMarker() {}, documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {}, edit() {},
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: async () => input.rendered,
    openLink: async (href: string) => { await pane.load(payload(href, "read")); return true; },
    openPath: async (file: string) => { calls.opened.push(file); await pane.load(payload(file, "read")); return true; },
    prepareDragExport: async (_text: string, _id: number, _rev: number, format: string) => ({ token: format, name: `long.${format}`, expiresAt: Date.now() + 30000 }),
    exportPdf: async () => { calls.saves.push("pdf"); }, exportHtml: async () => { calls.saves.push("html"); },
    startDragExport: (_id: number, _rev: number, token: string) => calls.drags.push(token),
    saveCopy: async (text: string) => { calls.copies.push(text); return "copy.md"; },
  } });
  const pane = createPane(root, makePaneId(0), { active: () => true, changed() {}, tabs: () => [] });
  pane.settings({ ...DEFAULT_SETTINGS, mode: "source", autosave: false });
  await pane.load(payload("/tmp/long.md", "edit")); await settle();
  const editor = root.querySelector<HTMLElement>(".cm-scroller")!;
  assert(editor.scrollHeight > editor.clientHeight * 2, "Source fixture does not scroll");
  editor.scrollTop = editor.scrollHeight; editor.dispatchEvent(new Event("scroll")); await settle();
  pane.command("mode-split");
  const preview = root.querySelector<HTMLElement>("#preview-scroll")!;
  const article = root.querySelector<HTMLElement>("#preview")!;
  await until(() => article.children.length > 100, "Side preview stayed blank"); await settle();
  assert(preview.scrollTop > 0 && preview.scrollHeight - preview.clientHeight - preview.scrollTop < 3, "Source end did not show preview end");
  const grow = document.createElement("div"); grow.style.height = "1600px"; article.firstElementChild!.append(grow); await settle();
  assert(preview.scrollHeight - preview.clientHeight - preview.scrollTop < 3, "Late preview layout lost the end anchor");

  await pane.navigate({ kind: "line", line: 201 }); await settle();
  pane.command("mode-split"); await settle();
  const editorAnchor = blockAnchor(article, preview);
  assert(editorAnchor.kind === "line" && editorAnchor.line >= 198 && editorAnchor.line <= 202, `Preview did not sync the source block: ${JSON.stringify(editorAnchor)}`);
  // Simulate user scrolling the preview. Its source range drives the editor without moving the cursor.
  preview.dispatchEvent(new WheelEvent("wheel"));
  restoreBlockAnchor(article, preview, { kind: "line", line: 100, offset: 0 });
  preview.dispatchEvent(new Event("scroll")); await settle();
  pane.command("mode-read"); await settle();
  const read = root.querySelector<HTMLElement>("#read-scroll")!;
  const readArticle = root.querySelector<HTMLElement>("#doc")!;
  const readAnchor = blockAnchor(readArticle, read);
  assert(readAnchor.kind === "line" && readAnchor.line >= 98 && readAnchor.line <= 102, `Read lost preview position: ${JSON.stringify(readAnchor)}`);
  pane.command("mode-source"); await settle(); pane.command("mode-read"); await settle();
  const roundTrip = blockAnchor(readArticle, read);
  assert(roundTrip.kind === "line" && roundTrip.line >= 98 && roundTrip.line <= 102, `Mode round trip lost position: ${JSON.stringify(roundTrip)}`);

  const before = blockAnchor(readArticle, read);
  const link = document.createElement("a"); link.href = "/tmp/other.md"; link.textContent = "Other"; readArticle.append(link); link.click();
  await until(() => pane.meta.path === "/tmp/other.md", "Sibling link did not navigate"); await settle();
  const back = root.querySelector<HTMLButtonElement>("#nav-back")!;
  assert(!back.hidden, "Back affordance stayed hidden"); back.click();
  await until(() => pane.meta.path === "/tmp/long.md", "Back did not restore the previous file"); await settle();
  const after = blockAnchor(readArticle, read);
  assert(before.kind === "line" && after.kind === "line" && Math.abs(before.line - after.line) <= 1, `Back lost scroll: ${JSON.stringify({ before, after })}`);

  const fragment = document.createElement("a"); fragment.href = "#part-80"; fragment.textContent = "Jump"; readArticle.append(fragment);
  const beforeFragment = blockAnchor(readArticle, read); fragment.click(); await settle();
  assert(!back.hidden && read.scrollTop > 0, "Heading link did not expose Back"); back.click(); await settle();
  const afterFragment = blockAnchor(readArticle, read);
  assert(beforeFragment.kind === "line" && afterFragment.kind === "line" && Math.abs(beforeFragment.line - afterFragment.line) <= 1, "Back from a heading link lost the scroll position");
  const format = root.querySelector<HTMLSelectElement>("#export-format")!;
  const exportButton = root.querySelector<HTMLButtonElement>("#drag-export")!;
  for (const value of ["html", "pdf"]) {
    format.value = value; format.dispatchEvent(new Event("change"));
    exportButton.click(); await frame();
    assert(calls.saves.at(-1) === value && exportButton.textContent === "Export", `Export click did not save ${value}`);
    exportButton.dispatchEvent(new PointerEvent("pointerenter")); await frame();
    exportButton.dispatchEvent(new Event("dragstart", { cancelable: true }));
    assert(calls.drags.at(-1) === value, `Drag export lost ${value}`);
  }

  pane.command("mode-source"); await settle();
  const content = root.querySelector<HTMLElement>(".cm-content")!;
  content.focus(); document.execCommand("insertText", false, "Mine "); await frame();
  assert(pane.flush().dirty, "Conflict fixture did not edit the document");
  const mine = pane.flush().text;
  pane.diskChanged("Incoming\n", pane.documentId);
  const banner = root.querySelector<HTMLElement>("#banner")!;
  const saveCopy = [...banner.querySelectorAll("button")].find(button => button.textContent === "Save mine as…");
  assert(saveCopy, "Conflict copy action is missing"); saveCopy.click(); await frame();
  assert(calls.copies.at(-1) === mine && pane.flush().text === mine && pane.flush().conflict && !banner.hidden, "Saving a copy lost a conflict version or dismissed the choices");
  pane.suspend();
  return { endSync: true, blockSync: true, layout: true, modeSwitch: true, back: true, export: true, conflict: true };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

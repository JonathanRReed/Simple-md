import { EditorView } from "@codemirror/view";
import { createPane } from "../../src/renderer/pane";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { closeOverlays } from "../../src/renderer/ui";
import { openQuickly } from "../../src/renderer/open-quickly";
import { rankQuicklyFiles } from "../../src/shared/open-quickly";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";
import type { RenderedBlocks } from "../../src/shared/render-core";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}
export async function runBatch(input: { text: string; rendered: RenderedBlocks; html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  document.body.dataset.platform = "darwin";
  applyDocumentStyle(DEFAULT_SETTINGS);
  const stage = document.querySelector<HTMLElement>("#stage")!;
  const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
  const root = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) element.dataset.element = element.id;
  stage.append(root);
  const commands: string[] = [];
  const api = {
    perfMarker() {}, documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {}, edit() {},
    relativePath: async () => "one/file.md",
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: async () => input.rendered,
    command: (cmd: string) => { commands.push(cmd); },
    // The palette lists what the native menu offers; these are the file and tab commands it carries.
    menuCommands: async () => ["copy-path", "copy-relative-path", "duplicate-file", "rename-move", "reopen-closed-tab", "default-markdown-app"].map(id => ({ id, enabled: true })),
    invokeMenu: async (id: string) => { commands.push(id); },
    writingContext() {}, proseCounts: async () => ({ document: { words: 0, characters: 0 }, minutes: 1 }),
  };
  Object.assign(window, { simplemd: api });
  const id = makeDocumentId(1), pane = createPane(root, makePaneId(0), { active: () => true, changed() {}, tabs: () => [] });
  pane.settings({ ...DEFAULT_SETTINGS, mode: "source", autosave: false, uiMotion: "off", tabStyle: "sidebar" });
  await pane.load({ ...input.rendered, documentId: id, paneId: makePaneId(0), revisionId: makeRevisionId(0), path: "/tmp/one/file.md", name: "file.md", baseUrl: "file:///tmp/one/", text: input.text, intent: "edit", initialMode: "source" });
  await until(() => !!root.querySelector(".cm-editor"), "Source editor did not mount");
  const view = EditorView.findFromDOM(root.querySelector(".cm-editor")!)!;
  view.dispatch({ changes: { from: 0, insert: "Edited " } });
  view.scrollDOM.scrollTop = 100; await paint(); const scroll = view.scrollDOM.scrollTop;
  const text = pane.flush().text;
  pane.saved({ moved: true, documentId: id, revisionId: makeRevisionId(1), path: "/tmp/two/renamed.md", name: "renamed.md", baseUrl: "file:///tmp/two/", text });
  await paint();
  assert(EditorView.findFromDOM(root.querySelector(".cm-editor")!) === view, "Move recreated the editor");
  assert(view.scrollDOM.scrollTop === scroll, "Move lost the scroll position");
  pane.command("undo"); assert(pane.flush().text === input.text, "Move lost undo history");
  pane.command("redo"); assert(pane.flush().text === text, "Move lost redo history");
  for (const [label, command] of [["Copy Path", "copy-path"], ["Copy Relative Path", "copy-relative-path"], ["Duplicate", "duplicate-file"], ["Rename or Move", "rename-move"], ["Reopen Closed Tab", "reopen-closed-tab"], ["Close Other Tabs", "close-other-tabs"], ["Close Tabs Below", "close-tabs-below"], ["Make SimpleMD the Default", "default-markdown-app"]]) {
    pane.command("palette"); await paint(); await paint();
    const picker = document.querySelector<HTMLInputElement>("#picker-input")!;
    picker.value = label!; picker.dispatchEvent(new Event("input"));
    assert(document.querySelector("#picker-list")!.textContent!.includes(label!), `Palette omitted ${label}`);
    picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert(commands.at(-1) === command, `Palette sent the wrong ${command}`);
  }
  const history = [{ path: "/tmp/history.md", source: "recent" as const, lastOpened: Date.now() - 3 * 86400000 }];
  openQuickly({ quicklyQuery: async () => rankQuicklyFiles(history, ""), quicklyOpen: async () => true, quicklyClose() {}, onQuicklyResults: () => () => {} }, "repo", history);
  await paint(); assert(document.querySelector("#picker-list")!.textContent!.includes("3 days ago"), "History omitted its relative time"); closeOverlays();
  pane.suspend();
  document.body.innerHTML = '<form id="settings"></form><p id="save-error" hidden></p><footer><span id="config-path"></span><div id="config-errors"></div></footer>';
  const actions: string[] = [];
  const snapshot = { settings: { ...DEFAULT_SETTINGS, launchAtLogin: false }, accent: "#0055aa", file: "/tmp/config", issues: [], fonts: ["Charter"] };
  Object.assign(window, { simplemdSettings: { get: async () => snapshot, set: async () => snapshot, subscribe() {}, action: async (action: string) => { actions.push(action); } } });
  await import("../../src/renderer/settings"); await paint();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  for (const label of ["Make SimpleMD the Default Markdown App", "Config file", "Open Config File", "Reveal"]) {
    const button = buttons.find(button => button.textContent === label)!;
    assert(button, `Settings omitted ${label}`); button.click(); await paint();
  }
  assert(JSON.stringify(actions) === JSON.stringify(["default-app", "open-config", "reveal-config"]), "Settings sent the wrong actions");
  assert(!document.querySelector<HTMLInputElement>("#launch-at-login")!.checked, "Settings ignored actual login registration");
  return { palette: true, movedState: true, historyTime: true, settingsActions: true };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

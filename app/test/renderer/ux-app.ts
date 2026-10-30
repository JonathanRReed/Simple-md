import { createPane } from "../../src/renderer/pane";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { openReadFind, closeOverlays } from "../../src/renderer/ui";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";
import type { RenderedBlocks } from "../../src/shared/render-core";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const wait = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}
export async function runBatch(input: { text: string; rendered: RenderedBlocks; html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  applyDocumentStyle(DEFAULT_SETTINGS);
  const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
  const stage = document.querySelector<HTMLElement>("#stage")!; stage.dataset.panes = "1";
  const root = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) element.dataset.element = element.id;
  stage.append(root);
  const calls = { settings: [] as unknown[], commands: [] as string[], tabs: [] as number[] };
  Object.assign(window, { simplemd: {
    perfMarker() {}, documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {}, edit() {},
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: async () => input.rendered,
    readFindText: async () => "", writeFindText: async () => {},
    setSettings: async (patch: unknown) => { calls.settings.push(patch); },
    activateTab: async (id: number) => { calls.tabs.push(id); },
    command: (cmd: string) => calls.commands.push(cmd),
  } });
  let settings = { ...DEFAULT_SETTINGS, autosave: false, mode: "source" as const, recents: ["/tmp/recent/RECENT.md"] };
  const pane = createPane(root, makePaneId(0), {
    active: () => true, changed() {},
    tabs: () => [{ id: makeDocumentId(1), name: "README.md", path: "/tmp/one/README.md" }, { id: makeDocumentId(2), name: "OTHER.md", path: "/tmp/two/OTHER.md" }],
  });
  pane.settings(settings);
  await pane.load({ ...input.rendered, documentId: makeDocumentId(1), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: "/tmp/one/README.md", name: "README.md", baseUrl: "file:///tmp/one/", text: input.text, intent: "read" });
  await wait();
  const scroll = root.querySelector<HTMLElement>("#read-scroll")!;
  const article = root.querySelector<HTMLElement>("#doc")!;
  scroll.focus();
  const before = article.innerHTML;
  const outside = document.createElement("p"); outside.textContent = "test repo"; document.body.append(outside);
  openReadFind(article, () => scroll.focus());
  const find = document.querySelector<HTMLInputElement>("#find-input")!;
  for (const char of "test repo") {
    find.value += char; find.dispatchEvent(new Event("input"));
    assert(document.activeElement === find, "Read Find stole focus while typing");
  }
  assert(find.value === "test repo", "Read Find lost a character");
  assert(document.querySelector("#find-count")!.textContent === "1 of 2", "Find did not count scoped inline matches");
  assert(CSS.highlights.get("read-matches")!.size === 2, "All Read matches are not highlighted");
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert(document.querySelector("#find-count")!.textContent === "2 of 2", "Enter did not advance Find");
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  assert(document.querySelector("#find-count")!.textContent === "1 of 2", "Shift+Enter did not go back");
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert(document.activeElement === scroll && !CSS.highlights.has("read-matches"), "Find did not close and restore focus");
  assert(article.innerHTML === before, "Find rewrote document HTML");
  openReadFind(article, () => scroll.focus(), "absent");
  assert(document.querySelector("#find-count")!.textContent === "0 of 0", "Empty Find count is wrong");
  closeOverlays(); outside.remove();

  for (const key of "hello t") scroll.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  assert(root.dataset.view === "read" && calls.settings.length === 0 && pane.flush().text === input.text, "Bare keys edited or persisted settings");
  const modes = root.querySelector<HTMLElement>("#modes")!;
  assert(!modes.hidden && modes.querySelector('[data-mode="read"]'), "Read mode control is missing");
  const options = root.querySelector<HTMLDetailsElement>("#reader-options")!;
  assert(!options.hidden, "Reader Aa control is hidden");
  settings = { ...settings, readingStyle: "github" };
  pane.settings(settings);
  assert(root.querySelector<HTMLButtonElement>("#reading-larger")!.disabled, "GitHub reader size remains editable");
  assert(!root.querySelector<HTMLElement>("#reading-override")!.hidden, "GitHub size override lacks an explanation");
  root.querySelector<HTMLButtonElement>("#reader-settings")!.click();
  assert(calls.commands.includes("preferences"), "Aa Settings action is disconnected");
  settings = { ...settings, readingStyle: "editorial" }; pane.settings(settings);
  root.querySelector<HTMLButtonElement>("#reading-larger")!.click();
  assert(JSON.stringify(calls.settings.at(-1)) === JSON.stringify({ readingFontSize: 21 }), "Reader size step is wrong");
  assert(root.querySelector<HTMLElement>("#changes")!.hidden, "Inactive change controls clutter Read");
  const firstHeading = article.querySelector("h1")!.getBoundingClientRect();
  assert(firstHeading.top - scroll.getBoundingClientRect().top < 30, `Read title has an empty band above it: ${firstHeading.top - scroll.getBoundingClientRect().top}, ${article.innerHTML.slice(0, 400)}`);

  pane.command("palette");
  const picker = document.querySelector<HTMLInputElement>("#picker-input")!;
  picker.value = "rdrhd"; picker.dispatchEvent(new Event("input"));
  assert(document.querySelector("#picker-list")!.textContent!.includes("Reader heading"), "Palette did not fuzzy-match headings");
  picker.value = "other"; picker.dispatchEvent(new Event("input"));
  assert(document.querySelector("#picker-list")!.textContent!.includes("OTHER.md"), "Palette omitted open tabs");
  picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert(calls.tabs.includes(2), "Palette did not activate a tab");
  pane.command("palette"); picker.value = "recent"; picker.dispatchEvent(new Event("input"));
  assert(document.querySelector("#picker-list")!.textContent!.includes("RECENT.md"), "Palette omitted recent files"); closeOverlays();

  scroll.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true, bubbles: true }));
  await until(() => root.dataset.view === "edit" && !!root.querySelector(".cm-content"), "Cmd+E did not deliberately open editing");
  pane.command("find");
  await until(() => !!root.querySelector(".cm-search input[name=search]"), "Editor Find did not open");
  const search = root.querySelector<HTMLInputElement>(".cm-search input[name=search]")!;
  search.value = "repo"; search.dispatchEvent(new Event("change", { bubbles: true })); await wait();
  assert(root.querySelector(".search-count")?.textContent === "0 of 2", "Editor Find count is missing");
  const replace = root.querySelector<HTMLInputElement>('.cm-search input[name="replace"]')!;
  replace.value = "repository"; replace.dispatchEvent(new Event("change", { bubbles: true }));
  root.querySelector<HTMLButtonElement>('.cm-search button[name="replaceAll"]')!.click(); await wait();
  assert(pane.flush().text.includes("**repository**") && !pane.flush().text.includes("repo example"), "Editor Replace did not apply");
  const dirty = root.querySelector<HTMLElement>("#dirty")!; const rect = dirty.getBoundingClientRect();
  assert(!dirty.hidden && dirty.textContent === "Edited" && rect.width > 0 && rect.right <= innerWidth, "Edited state is offscreen");
  assert(getComputedStyle(search).borderRadius === "5px", "Editor Find uses default styling");
  root.querySelector<HTMLButtonElement>('.cm-search [name="close"]')!.click();
  root.querySelector<HTMLButtonElement>('[data-mode="read"]')!.click();
  await until(() => root.dataset.view === "read", "Visible Read action did not work");
  pane.suspend();

  document.body.innerHTML = '<form id="settings"></form><p id="save-error" hidden></p><footer><span id="config-path"></span><div id="config-errors"></div></footer>';
  const snapshot = () => ({ settings, accent: "#0055aa", file: "/tmp/config", issues: [], fonts: ["Charter"] });
  Object.assign(window, { simplemdSettings: { get: async () => snapshot(), set: async () => snapshot(), subscribe() {} } });
  await import("../../src/renderer/settings"); await wait();
  const github = document.querySelector<HTMLInputElement>("#reading-style")!;
  github.checked = true; settings = { ...settings, readingStyle: "github" }; github.dispatchEvent(new Event("change")); await wait();
  for (const id of ["reading-font-family", "reading-font-size", "reading-line-height", "content-width"]) assert(document.querySelector<HTMLInputElement>(`#${id}`)!.disabled, `GitHub Settings still accepts ${id}`);
  assert(!document.querySelector<HTMLElement>("#reading-style-note")!.hidden, "Settings override explanation is missing");
  github.checked = false; settings = { ...settings, readingStyle: "editorial" }; github.dispatchEvent(new Event("change")); await wait();
  assert(!document.querySelector<HTMLInputElement>("#reading-font-size")!.disabled, "Switching style did not restore reading controls");
  return { readFind: true, readerControls: true, deliberateEdit: true, palette: true, editorFind: true, settings: true };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

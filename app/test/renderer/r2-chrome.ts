import { createTabBar } from "../../src/renderer/tab-bar";
import { createWindowChrome } from "../../src/renderer/window-chrome";
import { showConflictComparison } from "../../src/renderer/conflict-comparison";
import { createPane } from "../../src/renderer/pane";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";
import type { RenderedBlocks } from "../../src/shared/render-core";
import type { TabRow } from "../../src/shared/tab-presentation";
import type { EditorView } from "@codemirror/view";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}
export async function runBatch(input: { html: string; css: string; text: string; rendered: RenderedBlocks; scene: string; theme?: "light" | "dark" }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  document.body.dataset.platform = "darwin";
  document.documentElement.style.colorScheme = input.theme ?? "light";
  applyDocumentStyle(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, uiMotion: "off" as const, outlineRail: false };
  let saves = 0;
  const paneModes: string[] = [];
  const commands: string[] = [];
  let disk = input.text;
  const id = makeDocumentId(1), paneId = makePaneId(0);
  const api = {
    perfMarker() {}, documentReady() {}, paneMode(_id: unknown, mode: string) { paneModes.push(mode); }, releaseView() {}, editing() {}, setDirty() {}, edit() {},
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: async () => input.rendered, renderFragment: async () => ({ html: "" }),
    setChromeVisible() {}, command: (command: string) => { commands.push(command); },
    save: async (text: string) => { saves++; disk = text; return { text, documentId: id, revisionId: makeRevisionId(saves), path: "/tmp/PLAN.md", name: "PLAN.md", baseUrl: "file:///tmp/" }; },
    acceptDisk: async () => true,
    activateTab: async () => {}, closeTab: async () => true, tabContextMenu: async () => {}, setSettings: async () => {}, moveTab: async () => {},
  };
  Object.assign(window, { simplemd: api });
  const strip = document.querySelector<HTMLElement>("#tabs")!;
  const bar = createTabBar(strip, document.querySelector<HTMLElement>("#sidebar-divider")!, api);
  const names = ["PLAN.md", "PLAN_ARCHIVE.md", "Getting started.md", "Release checklist.md", "Reading notes.md", "Source examples.md"];
  let rows: TabRow[] = names.map((label, i) => ({ id: makeDocumentId(i + 1), label, title: `/tmp/${label}`, pinned: i < 2, selected: i === 0, dirty: false, pane: null }));
  bar.configure(settings); bar.render(rows); await paint();
  const pins = [...strip.querySelectorAll<HTMLElement>('.tab[data-pinned="true"]')];
  assert(pins[0]!.querySelector(".tab-short")!.textContent !== pins[1]!.querySelector(".tab-short")!.textContent, "Pins collide");
  const left = pins.map(pin => pin.getBoundingClientRect().left);
  const scroll = strip.querySelector<HTMLElement>(".tab-scroll")!;
  assert(scroll.dataset.overflowEnd === "true", "No trailing overflow cue");
  scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: 180, bubbles: true, cancelable: true })); await paint();
  assert(scroll.scrollLeft > 0 && scroll.dataset.overflowStart === "true", "Vertical wheel does not scroll tabs or reveal leading fade");
  scroll.dispatchEvent(new WheelEvent("wheel", { deltaX: 70, bubbles: true, cancelable: true })); await paint();
  assert(pins.every((pin, i) => pin.getBoundingClientRect().left === left[i]), "Pins scroll away");
  assert(scroll.getBoundingClientRect().left - pins.at(-1)!.getBoundingClientRect().right >= 12, "Pinned and scrolling labels lack a clean boundary");
  assert(getComputedStyle(strip.querySelector(".tab-pins")!).overflowX === "hidden", "Pinned labels can paint across the boundary");
  rows = rows.map((row, i) => ({ ...row, selected: i === 5 })); bar.render(rows); await paint();
  const selected = strip.querySelector<HTMLElement>('[aria-selected="true"]')!;
  if (input.scene !== "dirty") assert(selected.getBoundingClientRect().right <= scroll.getBoundingClientRect().right + 1, "Selected tab is clipped");
  const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
  const root = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) { element.dataset.element = element.id; element.removeAttribute("id"); }
  root.dataset.active = "true";
  const stage = document.querySelector<HTMLElement>("#stage")!; stage.dataset.panes = "1"; stage.append(root);
  const pane = createPane(root, paneId, { active: () => true, changed() {}, tabs: () => [] });
  pane.settings(settings);
  await pane.load({ ...input.rendered, documentId: id, paneId, revisionId: makeRevisionId(0), path: "/tmp/PLAN.md", name: "PLAN.md", baseUrl: "file:///tmp/", text: input.text, intent: "read" }); await paint();
  if (input.scene === "read-action") {
    root.querySelector<HTMLInputElement>(".task-list-item-checkbox")!.click();
    await until(() => saves === 1, "An explicit Read action lost autosave");
    assert(disk.includes("[x]"), "Read action saved the wrong text");
    return { passed: true };
  }
  const button = (query: string) => root.querySelector<HTMLButtonElement>(query)!;
  if (input.scene === "read-mode" || input.scene === "dirty") {
    button('[data-mode="source"]').click(); await paint();
    const editor = root.querySelector<HTMLElement>(".cm-content")! as HTMLElement & { cmTile: { root: { view: EditorView } } };
    editor.cmTile.root.view.dispatch({ changes: { from: 0, insert: "x" } });
    button('[data-mode="read"]').click(); await paint();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert(saves === 0 && pane.flush().dirty && pane.flush().text === "x" + input.text, "Read lost or saved a guarded edit");
    const retained = pane.suspend(); await pane.load({ ...input.rendered, documentId: id, paneId, revisionId: makeRevisionId(0), path: "/tmp/PLAN.md", name: "PLAN.md", baseUrl: "file:///tmp/", text: input.text, intent: "read" }, retained); await paint();
    assert(pane.flush().text === "x" + input.text && pane.flush().dirty, "Read snapshot lost a guarded edit");
    if (input.scene === "dirty") {
      const dirty = root.querySelector<HTMLElement>('[data-element="dirty"]')!;
      const visible = () => {
        const rect = dirty.getBoundingClientRect();
        assert(!dirty.hidden && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, "Edited label is offscreen");
        assert(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === dirty, "Edited label is covered");
      };
      for (const tabStyle of ["top", "sidebar"] as const) {
        bar.configure({ ...settings, tabStyle }); await paint(); visible();
        const chrome = createWindowChrome(api); chrome.configure({ ...settings, tabStyle, zenMode: true });
        document.querySelector("#chrome-reveal")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); await paint(); visible();
        chrome.configure(settings);
      }
      return { passed: true };
    }
    pane.command("save"); await until(() => saves === 1, "Read could not explicitly save a guarded edit");
    assert(disk === "x" + input.text, "Read saved the wrong pending text");
    button('[data-mode="source"]').click(); await paint();
    const restored = root.querySelector<HTMLElement>(".cm-content")! as typeof editor;
    restored.cmTile.root.view.dispatch({ changes: { from: 0, insert: "Confirmed editing\n" } });
    button('[data-mode="read"]').click();
    await until(() => saves === 2, "Read did not flush confirmed editing");
    assert(disk === "Confirmed editing\nx" + input.text, "Read flushed stale text");
    return { passed: true };
  }
  const aa = root.querySelector<HTMLDetailsElement>(".reader-options")!, summary = aa.querySelector("summary")!;
  aa.open = true; button('[data-element="reading-larger"]').focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert(!aa.open && document.activeElement === summary, "Aa Escape fails to close or return focus");
  aa.open = true; button('[data-element="reading-larger"]').focus();
  stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  assert(!aa.open && document.activeElement === summary, "Outside click fails to close Aa or return focus");
  const positions = [...root.querySelectorAll<HTMLElement>(".seg button, .layout-controls button")].map(node => node.getBoundingClientRect().left);
  for (const mode of ["live", "source", "live"]) {
    selected.focus(); button(`[data-mode="${mode}"]`).click();
    await until(() => !!root.querySelector(".cm-content"), "Editor did not mount"); await paint();
    assert(document.activeElement?.classList.contains("cm-content"), `Typing has no editor focus in ${mode}`);
    assert(!aa.hidden, "Aa slot disappeared");
    assert([...root.querySelectorAll<HTMLElement>(".seg button, .layout-controls button")].every((node, i) => node.getBoundingClientRect().left === positions[i]), "Mode switch moved toolbar icons");
  }
  button('[data-mode="read"]').click(); await paint();
  rows = rows.map(row => ({ ...row, selected: row.id === id })); bar.render(rows); await paint();
  assert(strip.querySelector<HTMLElement>('[aria-selected="true"]')!.dataset.documentId === root.dataset.documentId, "Capture selected a different document");
  if (input.scene === "tabs") return { passed: true };
  if (input.scene === "sidebar") {
    bar.configure({ ...settings, tabStyle: "sidebar" });
    bar.render([...rows, ...Array.from({ length: 30 }, (_, index) => ({ id: makeDocumentId(index + 20), label: `Note ${index}.md`, title: `/tmp/Note ${index}.md`, pinned: false, selected: false, dirty: false, pane: null }))]);
    await paint();
    const top = pins.map(pin => pin.getBoundingClientRect().top);
    scroll.scrollTop = 300; await paint();
    assert(scroll.scrollTop > 0 && pins.every((pin, i) => pin.getBoundingClientRect().top === top[i]), "Sidebar pins scroll away");
    return { passed: true };
  }
  const chrome = createWindowChrome(api); chrome.configure({ ...settings, zenMode: true }); await paint();
  assert(document.querySelector<HTMLElement>("#zen-hint")!.textContent!.includes("Esc or ⌘⇧J"), "Zen lacks entry hint");
  document.querySelector("#chrome-reveal")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); await paint();
  for (const target of [button('[data-mode="live"]'), summary]) {
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert(hit === target || !!hit && target.contains(hit), "Revealed zen toolbar cannot receive clicks");
  }
  aa.open = true;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert(!aa.open && commands.length === 0, "Aa Escape also exited zen");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert(commands.at(-1) === "toggle-zen", "Escape does not exit zen");
  if (input.scene === "zen") return { passed: true };
  chrome.configure(settings);
  button('[data-mode="source"]').click(); await paint();
  const editor = root.querySelector<HTMLElement>(".cm-content")! as HTMLElement & { cmTile: { root: { view: EditorView } } };
  const view = editor.cmTile.root.view;
  view.dispatch({ changes: { from: 0, insert: "x" } });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert(saves === 0 && disk === input.text && pane.flush().dirty, "Tiny edit autosaved");
  const payload = { ...input.rendered, documentId: id, paneId, revisionId: makeRevisionId(0), path: "/tmp/PLAN.md", name: "PLAN.md", baseUrl: "file:///tmp/", text: input.text, intent: "read" as const };
  const retained = pane.suspend(); await paint(); assert(saves === 0, "Tab switch bypassed the first-save guard");
  paneModes.length = 0;
  await pane.load(payload, retained); await paint();
  assert(!paneModes.includes("read"), "Restoring an editor published a temporary Read mode");
  pane.command("save"); await until(() => saves === 1, "Explicit save did not release the guard");
  const restored = root.querySelector<HTMLElement>(".cm-content")! as typeof editor;
  restored.cmTile.root.view.dispatch({ changes: { from: 0, insert: "y" } });
  await until(() => saves === 2, "Autosave did not resume after explicit save");
  restored.cmTile.root.view.dispatch({ changes: { from: 0, insert: "Local decision\n" } });
  const incoming = "# PLAN\n\nIncoming decision from disk.\n<script>throw new Error('unsafe')</script>\n";
  pane.diskChanged(incoming, id); await paint();
  const banner = root.querySelector<HTMLElement>('[data-element="banner"]')!;
  const compare = [...banner.querySelectorAll("button")].find(node => node.textContent === "View incoming changes")!;
  assert(compare && ["Reload", "Keep mine", "Save mine as…"].every(label => banner.textContent!.includes(label)), "Conflict actions missing");
  const closeLong = showConflictComparison("local\n".repeat(200), "incoming\n".repeat(300)); await paint();
  const longPanes = document.querySelectorAll<HTMLPreElement>(".conflict-comparison pre");
  longPanes[0]!.dispatchEvent(new WheelEvent("wheel")); longPanes[0]!.scrollTop = (longPanes[0]!.scrollHeight - longPanes[0]!.clientHeight) / 2;
  longPanes[0]!.dispatchEvent(new Event("scroll")); await paint();
  assert(Math.abs(longPanes[1]!.scrollTop / (longPanes[1]!.scrollHeight - longPanes[1]!.clientHeight) - 0.5) < 0.01, "Comparison scroll positions do not track");
  closeLong();
  const local = pane.flush().text; compare.focus(); compare.click(); await paint();
  const dialog = document.querySelector<HTMLDialogElement>(".conflict-comparison")!;
  const columns = dialog.querySelectorAll("pre");
  assert(dialog.open && columns[0]!.textContent === local && columns[1]!.textContent === incoming, "Comparison lost local or disk text");
  assert(!dialog.querySelector("script, [contenteditable=true]") && pane.flush().text === local, "Incoming comparison executed or edited content");
  dialog.dispatchEvent(new Event("cancel", { cancelable: true })); await paint();
  assert(!dialog.isConnected && pane.flush().conflict && document.activeElement === compare, "Closing comparison resolved the conflict or lost focus");
  compare.click(); await paint();
  pane.diskChanged(incoming + "newer", id); await paint();
  assert(!document.querySelector("dialog"), "A newer disk event left stale incoming text visible");
  [...banner.querySelectorAll("button")].find(node => node.textContent === "View incoming changes")!.click(); await paint();
  return { passed: true };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

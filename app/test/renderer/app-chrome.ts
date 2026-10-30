import type { RenderedBlocks } from "../../src/shared/render-core";
import type { Bridge } from "../../src/renderer/api";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(fn: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}
export async function runBatch(input: { rendered: RenderedBlocks; html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  let onDoc: Parameters<Bridge["onDoc"]>[0] | undefined;
  let onLayout: Parameters<Bridge["onLayout"]>[0] | undefined;
  const ready = new Set<number>();
  Object.assign(window, { simplemd: {
    ready: async () => ({ settings: { ...DEFAULT_SETTINGS, autosave: false }, platform: "darwin", accent: "#0055aa" }),
    onContextMenu() {}, onNavigate() {}, onClosed() {}, onSaved() {}, onDiskChanged() {}, onTransition() {}, onCommand() {}, onSettings() {}, onFlushRequest() {},
    onDoc(cb: typeof onDoc) { onDoc = cb; }, onLayout(cb: typeof onLayout) { onLayout = cb; },
    perfMarker() {}, documentReady(id: number) { ready.add(id); }, paneMode() {}, releaseView() {},
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
  } });
  await import("../../src/renderer/app");
  await until(() => !!onDoc && !!onLayout, "App did not boot");
  const first = makeDocumentId(1), second = makeDocumentId(2), pane0 = makePaneId(0), pane1 = makePaneId(1);
  const payload = (id: typeof first, folder: string) => ({ ...input.rendered, documentId: id, paneId: pane0, revisionId: makeRevisionId(0), path: `/tmp/${folder}/README.md`, name: "README.md", baseUrl: `file:///tmp/${folder}/`, text: "# Title\n\nText\n", intent: "read" as const });
  onDoc!(payload(first, "one")); onDoc!(payload(second, "two"));
  onLayout!({ tabs: [first, second], panes: [{ paneId: pane0, documentId: first }], activePane: pane0, axis: "horizontal" });
  await until(() => ready.has(first), "First tab did not load");
  const names = [...document.querySelectorAll<HTMLElement>(".tab-name")];
  assert(names[0]?.textContent === "README.md · one" && names[1]?.textContent === "README.md · two", "Duplicate tabs omit their folders");
  assert(document.querySelector(".tb-title")!.textContent === "README.md" && document.title === "README.md", "Two tabs cleared the active title");
  assert(document.querySelector<HTMLElement>(".tb-title")!.title === "/tmp/one/README.md", "Title path is not active");
  const tab = document.querySelector<HTMLElement>(".tab")!; tab.style.width = "100px"; tab.style.minWidth = "0";
  const start = tab.querySelector<HTMLElement>(".tab-name-start")!, end = tab.querySelector<HTMLElement>(".tab-name-end")!;
  assert(getComputedStyle(start).textOverflow === "ellipsis" && getComputedStyle(end).flexShrink === "0" && !!end.textContent, "Tab names do not preserve their ending");
  onLayout!({ tabs: [first, second], panes: [{ paneId: pane0, documentId: first }, { paneId: pane1, documentId: second }], activePane: pane1, axis: "horizontal" });
  await until(() => ready.has(second), "Second pane did not load");
  assert(document.querySelector<HTMLElement>(".tb-title")!.title === "/tmp/two/README.md", "Active title did not follow the split pane");
  const paneNames = [...document.querySelectorAll<HTMLElement>(".pane-name")];
  assert(paneNames.length === 2 && paneNames.every(name => name.textContent!.includes("README.md") && name.getBoundingClientRect().width > 30 && getComputedStyle(name).position !== "absolute"), "Split pane file names are hidden");
  return { activeTitle: true, duplicateNames: true, middleTruncation: true, paneNames: true };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

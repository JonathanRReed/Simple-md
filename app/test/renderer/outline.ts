import { createPane } from "../../src/renderer/pane";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId, type Settings } from "../../src/shared/types";
import type { RenderedBlocks } from "../../src/shared/render-core";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(10); }
  throw new Error(message);
}

export async function runBatch(input: { text: string; theme: "light" | "dark"; rendered: RenderedBlocks; html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  const settings: Settings = { ...DEFAULT_SETTINGS, theme: input.theme, autosave: false };
  applyDocumentStyle(settings);
  document.documentElement.style.colorScheme = input.theme;
  const template = document.querySelector<HTMLTemplateElement>("#pane-template")!;
  const stage = document.querySelector<HTMLElement>("#stage")!; stage.dataset.panes = "1";
  const root = template.content.firstElementChild!.cloneNode(true);
  assert(root instanceof HTMLElement, "Pane template missing");
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) element.dataset.element = element.id;
  stage.append(root);
  let deferred = false;
  Object.assign(window, { simplemd: {
    perfMarker(_id: number, marker: string) { if (marker === "first-readable") deferred = !root.querySelector(".outline-rail"); },
    documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {}, edit() {},
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: async () => input.rendered, renderFragment: async () => ({ html: "" }),
    readFindText: async () => "", writeFindText: async () => {},
  } });
  const pane = createPane(root, makePaneId(0), { active: () => false, changed() {}, tabs: () => [] });
  pane.settings(settings);
  await pane.load({ ...input.rendered, documentId: makeDocumentId(1), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: "/tmp/outline.md", name: "Outline.md", baseUrl: "file:///tmp/", text: input.text, intent: "read" });
  await until(() => root.querySelectorAll(".outline-strip").length === 30, "Read rail did not build");
  await pause(150);
  const read = root.querySelector<HTMLElement>('[data-element="read"]')!;
  const scroll = root.querySelector<HTMLElement>('[data-element="read-scroll"]')!;
  const rail = read.querySelector<HTMLElement>(".outline-rail")!;
  const buttons = () => [...rail.querySelectorAll<HTMLButtonElement>("button")];
  assert(rail.tagName === "NAV" && rail.getAttribute("aria-label") === "Outline", "Outline landmark missing");
  assert(buttons()[0]!.getAttribute("aria-label") === "Heading level 1: Reading <safely> & writing", "Heading label lost text");
  assert(buttons().filter(button => button.tabIndex === 0).length === 1, "Rail is not a single tab stop");
  assert(getComputedStyle(scroll).scrollbarWidth === "none", "Native scrollbar still visible");
  assert(scroll.getBoundingClientRect().right <= rail.getBoundingClientRect().left, "Rail overlaps document measure");
  rail.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: rail.getBoundingClientRect().top + 2 }));
  const tooltip = rail.querySelector<HTMLElement>('[role="tooltip"]')!;
  assert(!tooltip.hidden && tooltip.textContent === "H1 · Reading <safely> & writing" && !tooltip.querySelector("safely"), "Tooltip is missing or interprets HTML");
  assert(buttons()[0]!.firstElementChild!.getAttribute("style")!.includes("scaleX(1)"), "Hover does not magnify");
  buttons()[20]!.click();
  const heading = root.querySelectorAll<HTMLElement>('[data-element="doc"] :is(h1,h2,h3)')[20]!;
  await until(() => Math.abs(heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16) < 3, "Click did not jump to heading");
  await until(() => buttons()[20]!.dataset.inView === "true" && buttons()[0]!.dataset.inView === "false", "In-view strip state did not follow scrolling");
  const articleForReflow = root.querySelector<HTMLElement>('[data-element="doc"]')!;
  articleForReflow.style.fontSize = "23px";
  await until(() => Math.abs(heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16) < 3, "Reflow lost the selected heading");
  articleForReflow.style.removeProperty("font-size");
  await pause();
  const delayed = document.createElement("div"); delayed.style.height = "450px";
  articleForReflow.firstElementChild!.append(delayed);
  // Browser scroll anchoring may fire before ResizeObserver reports offscreen layout.
  scroll.scrollTop += 40; scroll.dispatchEvent(new Event("scroll"));
  await until(() => Math.abs(heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16) < 3, "First jump was cancelled by offscreen layout scroll");
  scroll.dispatchEvent(new WheelEvent("wheel"));
  const released = scroll.scrollTop; delayed.style.height = "550px";
  await pause(100);
  assert(Math.abs(scroll.scrollTop - released) < 120, "User input did not release outline navigation");
  delayed.remove();
  assert(rail.querySelector<HTMLElement>(".outline-viewport")!.style.transform.includes("scaleY("), "Viewport indicator missing");
  buttons()[0]!.focus();
  buttons()[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
  assert(document.activeElement === buttons()[1], "Arrow navigation failed");
  buttons()[1]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
  assert(document.activeElement === buttons().at(-1), "End navigation failed");
  buttons().at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
  assert(document.activeElement === buttons()[0], "Home navigation failed");
  const focusedButton = document.activeElement;
  pane.settings(settings); await pause(100);
  assert(document.activeElement === focusedButton && focusedButton?.isConnected, "Outline refresh lost keyboard focus");
  // Synthetic PointerEvents have no active native pointer. The smoke cases cover real capture.
  rail.setPointerCapture = () => {};
  const rect = rail.getBoundingClientRect();
  rail.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientY: rect.top + 5, button: 0 }));
  rail.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: rect.bottom - 1, buttons: 1 }));
  rail.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientY: rect.bottom - 1 }));
  assert(scroll.scrollTop > (scroll.scrollHeight - scroll.clientHeight) * 0.98, "Scrub did not reach document end");
  articleForReflow.style.fontSize = "25px";
  await until(() => scroll.scrollTop > (scroll.scrollHeight - scroll.clientHeight) * 0.98, "Reflow lost the scrub fraction");
  articleForReflow.style.removeProperty("font-size"); await pause();
  buttons()[0]!.focus();
  buttons()[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  await until(() => scroll.scrollTop === 0, "Keyboard activation after scrubbing failed");
  scroll.scrollTop = 0; await pause();
  rail.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: rect.top + 2 }));
  await pane.command("mode-split");
  await until(() => !!root.querySelector('[data-element="preview-pane"] .outline-strip'), "Split preview rail missing");
  assert(!root.querySelector('[data-element="editor-host"] .outline-rail'), "Split source editor lost its native scrollbar");
  await pane.command("mode-live");
  await until(() => !!root.querySelector('[data-element="editor-host"] .outline-strip'), "Live rail missing");
  assert(root.querySelector('.cm-scroller')?.classList.contains("outline-scroll"), "Live scrollbar did not transfer to rail");
  const liveButtons = root.querySelectorAll<HTMLButtonElement>('[data-element="editor-host"] .outline-strip');
  liveButtons[10]!.click();
  await until(() => root.querySelector<HTMLElement>(".cm-scroller")!.scrollTop > 0, "Live rail did not jump");
  await pane.command("mode-source");
  await until(() => !root.querySelector(".outline-rail"), "Source kept outline rail");
  assert(!root.querySelector('.cm-scroller')?.classList.contains("outline-scroll"), "Source scrollbar hidden");
  await pane.command("mode-read");
  await until(() => !!root.querySelector(".outline-strip"), "Read rail did not return");
  pane.settings({ ...settings, outlineRail: false });
  assert(!root.querySelector(".outline-rail") && !scroll.classList.contains("outline-scroll"), "Disabling did not restore scrollbar");
  pane.settings({ ...settings, outlineRailLevels: 1 });
  await until(() => root.querySelectorAll(".outline-strip").length === 10, "Level filter not applied");
  // Replace the already-rendered blocks to test heading-free fallback without parsing.
  const article = root.querySelector<HTMLElement>('[data-element="doc"]')!;
  for (const h of article.querySelectorAll("h1,h2,h3")) h.remove();
  pane.settings(settings);
  await until(() => !!root.querySelector('.outline-strip[data-level="0"]'), "Heading-free section ticks missing");
  // Reload the real document for the screenshot, with the first tooltip visible.
  pane.suspend();
  await pane.load({ ...input.rendered, documentId: makeDocumentId(2), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: "/tmp/outline.md", name: "Outline.md", baseUrl: "file:///tmp/", text: input.text, intent: "read" });
  await until(() => root.querySelectorAll(".outline-strip").length === 30, "Reload retained stale rail");
  await pause(150);
  const shotRail = root.querySelector<HTMLElement>(".outline-rail")!;
  shotRail.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: shotRail.getBoundingClientRect().top + 2 }));
  await pause(200);
  assert(!shotRail.querySelector<HTMLElement>(".outline-tooltip")!.hidden, "Screenshot tooltip disappeared");
  return { aria: true, hover: true, jump: true, keyboard: true, inView: true, scrub: true, split: true, live: true, source: true, disabled: true, fallback: true, deferred };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

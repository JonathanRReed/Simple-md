import { createTabBar } from "../../src/renderer/tab-bar";
import { armMotion, capturePaneBounds, configureMotion, flipPaneBounds, motionEnabled } from "../../src/renderer/motion";
import { openPicker, closeOverlays } from "../../src/renderer/ui";
import { DEFAULT_SETTINGS, makeDocumentId, type Settings } from "../../src/shared/types";
import type { TabRow } from "../../src/shared/tab-presentation";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const settle = async () => { for (const animation of document.getAnimations()) animation.finish(); await paint(); };
export async function runBatch(input: { html: string; css: string; reduced: boolean; capture?: string; style?: Settings["tabStyle"] }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const css = document.createElement("style"); css.textContent = input.css; document.head.append(css);
  document.documentElement.style.colorScheme = "dark";
  document.body.dataset.platform = "darwin";
  const strip = document.querySelector<HTMLElement>("#tabs")!;
  const stage = document.querySelector<HTMLElement>("#stage")!;
  let settings: Settings = { ...DEFAULT_SETTINGS, tabStyle: input.style ?? "top" };
  const configure = (patch: Partial<Settings>) => { settings = { ...settings, ...patch }; configureMotion(settings); bar.configure(settings); };
  const bar = createTabBar(strip, document.querySelector<HTMLElement>("#sidebar-divider")!, {
    activateTab: async () => {}, closeTab: async () => true, tabContextMenu: async () => {}, setSettings: async () => {}, moveTab: async () => {},
  });
  const row = (n: number, selected = false, pinned = false): TabRow => ({ id: makeDocumentId(n), label: ["", "Reading.md", "Notes.md", "Working draft.md"][n]!, title: `/tmp/${n}.md`, dirty: false, selected, pinned, pane: null });
  const rows = [row(1, true), row(2)];
  const pane = (id: string) => {
    const fragment = document.querySelector<HTMLTemplateElement>("#pane-template")!.content.cloneNode(true);
    assert(fragment instanceof DocumentFragment, "Missing pane template");
    const element = fragment.querySelector<HTMLElement>(".document-pane")!;
    element.dataset.documentId = id; element.dataset.active = String(id === "1");
    for (const node of element.querySelectorAll<HTMLElement>("[id]")) node.dataset.element = node.id;
    const article = element.querySelector<HTMLElement>(".prose")!; article.hidden = false;
    article.innerHTML = '<h1>A quieter page</h1><p>Read and write without losing your place.</p>' + '<h2>Notes</h2><p>Keep the document still while the window controls move.</p>'.repeat(12);
    element.querySelector<HTMLElement>('[data-element="empty"]')!.hidden = true;
    element.querySelector<HTMLElement>('[data-element="edit"]')!.hidden = true;
    element.querySelector<HTMLElement>('[data-element="modes"]')!.hidden = false;
    element.querySelector<HTMLElement>('[data-element="name"]')!.textContent = id === "1" ? "Reading.md" : "Notes.md";
    stage.append(element); return element;
  };
  stage.dataset.panes = "1"; stage.dataset.axis = "horizontal";
  const first = pane("1"), content = first.querySelector<HTMLElement>(".pane-content")!;
  configure({}); bar.render(rows); await paint();
  assert(!motionEnabled() && document.getAnimations().length === 0, "Startup animated");
  armMotion(); await paint();
  assert(motionEnabled() === !input.reduced, "Reduced motion policy was ignored");
  const enabled = !input.reduced;
  if (input.capture === "tab-close") { bar.render([...rows, row(3)]); await settle(); }
  if (input.capture === "sidebar") { configure({ tabStyle: "sidebar" }); await settle(); }
  if (input.capture === "split-axis" || input.capture === "split-close") { pane("2"); stage.dataset.panes = "2"; await paint(); }
  const action = input.capture ?? "tab-add";
  if (action === "tab-add") bar.render([...rows, row(3)]);
  else if (action === "tab-close") bar.render(rows);
  else if (action === "sidebar") configure({ sidebarCollapsed: true });
  else {
    const before = capturePaneBounds();
    if (action === "split-axis") stage.dataset.axis = "vertical";
    else if (action === "split-close") { stage.lastElementChild!.remove(); stage.dataset.panes = "1"; }
    else { pane("2"); stage.dataset.panes = "2"; }
    flipPaneBounds(before);
  }
  if (input.capture) {
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 0; }
    return { capture: input.capture, animations: document.getAnimations().length };
  }
  assert(document.querySelector('[data-document-id="3"]'), "Tab addition waited for animation");
  assert(!!strip.querySelector(".chrome-motion") === enabled, "Tab entry policy is wrong");
  await settle();
  bar.render([row(2, true), row(3), row(1)]);
  assert(strip.firstElementChild?.getAttribute("data-document-id") === "2", "Reorder waited for animation");
  assert(strip.querySelector('.tab[aria-selected="true"] .tab-indicator'), "Active pill did not move");
  if (enabled) assert(strip.querySelector(".chrome-motion"), "Reorder did not FLIP");
  await settle();
  bar.render([row(2, true, true), row(3), row(1)]); await settle();
  bar.render([row(2, true, true), row(1)]);
  assert(!!document.querySelector(".chrome-exit") === enabled, "Close did not respect policy");
  assert(strip.children.length === 2, "Closed tab still accepts input");
  assert(document.querySelectorAll('[role="tab"]').length === 2, "Exit copy retained tab semantics");
  await settle();
  configure({ tabStyle: "sidebar" }); await settle();
  const scroller = first.querySelector<HTMLElement>(".scroller")!;
  scroller.scrollTop = 300; const top = scroller.scrollTop;
  const width = content.offsetWidth;
  configure({ sidebarCollapsed: true });
  assert(strip.hidden && stage.getBoundingClientRect().width === innerWidth, "Sidebar did not commit its layout");
  assert(content.offsetWidth === (enabled ? width : stage.clientWidth), "Document reflowed during FLIP");
  if (enabled) {
    const range = document.createRange(); range.selectNodeContents(first.querySelector("p")!);
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 70; }
    const textWidth = range.getBoundingClientRect().width;
    configure({ uiMotion: "off" });
    assert(document.getAnimations().length === 0 && !document.querySelector(".chrome-exit"), "Off did not cancel immediately");
    assert(Math.abs(range.getBoundingClientRect().width - textWidth) < 0.2, "FLIP scaled document text");
  }
  assert(!content.style.width && !content.style.height && scroller.scrollTop === top, `Layout cleanup changed the reading position: style=${content.getAttribute("style")} top=${scroller.scrollTop} expected=${top}`);
  configure({ uiMotion: "subtle", sidebarCollapsed: false }); await settle();
  document.body.classList.add("resizing-sidebar");
  assert(capturePaneBounds().size === 0, "Resize drag animated");
  document.body.classList.remove("resizing-sidebar");
  const before = capturePaneBounds(); pane("2"); stage.dataset.panes = "2"; flipPaneBounds(before);
  if (enabled) assert(first.querySelector(".pane-viewport")!.getAnimations().length > 0 && content.offsetWidth === width, "Split did not freeze the document");
  assert(first.querySelector(".pane-controls")!.getBoundingClientRect().top < 38, "Pane motion moved the fixed toolbar");
  await settle();
  const axis = capturePaneBounds(); stage.dataset.axis = "vertical"; flipPaneBounds(axis); await settle();
  assert(!content.style.width && !content.style.height, "Stacked panes retained frozen dimensions");
  openPicker("Commands", [{ label: "Read", run() {} }], () => {});
  assert(!!document.querySelector(".picker-card.chrome-motion") === enabled, "Panel entry policy is wrong");
  closeOverlays();
  assert(document.querySelector<HTMLElement>("#picker")!.hidden, "Panel close waited for animation");
  await settle();
  configure({ uiMotion: "off" }); bar.render([row(1, true), row(2), row(3)]);
  assert(document.getAnimations().length === 0, "Off allowed a new animation");
  assert(getComputedStyle(strip.querySelector(".tab-close")!).transitionDuration === "0s", "Off retained CSS motion");
  assert(getComputedStyle(document.querySelector("#sidebar-search-input")!, "::placeholder").color === "rgb(184, 184, 184)", "Dark search placeholder lost its contrast");
  const luminance = (color: string) => {
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(channel => {
      const value = Number(channel) / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  for (const appearance of ["light", "dark"]) {
    document.documentElement.style.colorScheme = appearance;
    const text = luminance(getComputedStyle(document.querySelector("#sidebar-search-input")!, "::placeholder").color);
    const background = luminance(getComputedStyle(document.querySelector("#sidebar-search")!).backgroundColor);
    assert((Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05) >= 4.5, `${appearance} search placeholder fails AA`);
  }
  return { startup: true, tabs: true, pill: true, sidebar: true, split: true, panels: true, off: true, reduced: input.reduced };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch, afterFrames() {
  assert(!document.querySelector(".chrome-exit, .chrome-motion"), "Capture retained a finished animation");
  assert([...document.querySelectorAll<HTMLElement>(".pane-content")].every(node => !node.style.width && !node.style.height), "Capture retained frozen document dimensions");
} } });

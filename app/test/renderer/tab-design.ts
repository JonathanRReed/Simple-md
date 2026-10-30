import { createTabBar } from "../../src/renderer/tab-bar";
import { createWindowChrome } from "../../src/renderer/window-chrome";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { configSchema } from "../../src/shared/config-schema";
import { DEFAULT_SETTINGS, makeDocumentId } from "../../src/shared/types";
import type { TabRow } from "../../src/shared/tab-presentation";

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
export async function runBatch(input: { html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  document.body.dataset.platform = "darwin";
  document.documentElement.style.colorScheme = "light";
  const strip = document.querySelector<HTMLElement>("#tabs")!, divider = document.querySelector<HTMLElement>("#sidebar-divider")!;
  const nativeVisibility: boolean[] = [], moves: unknown[] = [];
  const chrome = createWindowChrome({ setChromeVisible: value => { nativeVisibility.push(value); } });
  const bar = createTabBar(strip, divider, { activateTab: async () => {}, closeTab: async () => true, tabContextMenu: async () => {}, setSettings: async () => {}, moveTab: async (...args) => { moves.push(args); } });
  const rows: TabRow[] = Array.from({ length: 12 }, (_, i) => ({ id: makeDocumentId(i), label: i === 0 ? "pinned-readme.md" : "gyp-jumping-ceiling-notes.md", title: `/notes/${i}.md`, selected: i === 1, dirty: i === 1, pinned: i === 0, pane: null }));
  bar.configure(DEFAULT_SETTINGS); bar.render(rows); await paint();
  const pin = strip.children[0] as HTMLElement, row = strip.children[1] as HTMLElement;
  assert(pin.getAttribute("aria-label")?.includes("pinned") && pin.title === rows[0]!.title, "Pin name or tooltip lost file identity");
  assert(pin.querySelector<HTMLButtonElement>(".tab-close")!.hidden && pin.getBoundingClientRect().width === 42, "Horizontal pin has a close button or wrong width");
  assert(strip.getAttribute("aria-orientation") === "horizontal" && strip.getAttribute("role") === "tablist", "Tab list ARIA changed");
  assert(row.getAttribute("aria-selected") === "true" && row.tabIndex === 0, "Roving tab focus lost selection");
  assert(row.querySelector(".tab-action")?.children.length === 2, "Dirty dot and close do not share a slot");
  assert(getComputedStyle(row).borderInlineEndWidth === "0px" && getComputedStyle(row).height === "28px", "Tabs have separators or wrong height");
  const name = row.querySelector<HTMLElement>(".tab-name")!, end = row.querySelector<HTMLElement>(".tab-name-end")!;
  assert(end.textContent === rows[1]!.label.slice(-7), "Label lost its seven-character tail");
  const font = getComputedStyle(name), canvas = document.createElement("canvas").getContext("2d")!;
  canvas.font = `${font.fontSize} ${font.fontFamily}`;
  const metrics = canvas.measureText(name.textContent!);
  assert(name.getBoundingClientRect().height >= metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent, "Label clips glyph height");
  assert(parseFloat(font.lineHeight) >= parseFloat(font.fontSize) * 1.4, "Label line height clips descenders");
  assert(strip.scrollWidth > strip.clientWidth && getComputedStyle(strip).overflowX === "auto", "Tabs cannot overflow horizontally");
  assert([...strip.children].slice(1).every(node => node.getBoundingClientRect().width >= 108), "Overflow compressed tabs below readable width");
  strip.scrollLeft = 400; await paint(); assert(strip.scrollLeft > 0, "Overflow does not scroll");
  assert(row.getBoundingClientRect().top < 34 && strip.getBoundingClientRect().left >= 84, "Horizontal tabs do not share the titlebar safely");
  const fill = getComputedStyle(row).backgroundColor;
  for (const themeLight of configSchema["theme-light"].options) {
    applyDocumentStyle({ ...DEFAULT_SETTINGS, themeLight });
    assert(getComputedStyle(row).backgroundColor === fill, `Document theme ${themeLight} colored chrome`);
  }
  for (const themeDark of configSchema["theme-dark"].options) {
    applyDocumentStyle({ ...DEFAULT_SETTINGS, themeDark });
    assert(getComputedStyle(row).backgroundColor === fill, `Document theme ${themeDark} colored chrome`);
  }
  for (const platform of ["win32", "linux"]) {
    document.body.dataset.platform = platform;
    assert(!getComputedStyle(document.body).backgroundColor.startsWith("rgba"), `${platform} frame is translucent`);
    assert(getComputedStyle(row).borderRadius === "6px", `${platform} has the wrong tab radius`);
  }
  document.body.dataset.platform = "darwin";
  bar.configure({ ...DEFAULT_SETTINGS, tabStyle: "sidebar" }); await paint();
  assert(pin.querySelector<HTMLElement>(".tab-name")!.getBoundingClientRect().width > 0, "Sidebar pin lost full label");
  assert(getComputedStyle(row).marginBlockStart === "9px", "Pin section has no spacing");
  assert(getComputedStyle(divider, "::after").backgroundColor === "rgba(0, 0, 0, 0)", "Divider is visible at rest");
  const transfer = new DataTransfer();
  row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
  pin.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  row.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
  assert(JSON.stringify(moves[0]) === JSON.stringify([rows[1]!.id, true, rows[0]!.id]), "Drag into pinned section did not pin before the target");
  bar.configure({ ...DEFAULT_SETTINGS, tabStyle: "sidebar", sidebarCollapsed: true }); await paint();
  assert(strip.hidden && divider.hidden, "Collapsed sidebar keeps controls visible");
  const stage = document.querySelector<HTMLElement>("#stage")!;
  chrome.configure({ ...DEFAULT_SETTINGS, zenMode: true }); await paint();
  assert(getComputedStyle(document.querySelector(".titlebar")!).visibility === "hidden", "Zen titlebar remains visible");
  assert(stage.getBoundingClientRect().top === 0, "Zen still reserves titlebar space");
  const bounds = stage.getBoundingClientRect();
  const edge = document.querySelector<HTMLElement>("#chrome-reveal")!;
  edge.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); await paint();
  assert(document.body.dataset.chromeRevealed === "true" && nativeVisibility.at(-1) === true, "Top edge does not reveal native and rendered chrome");
  assert(stage.getBoundingClientRect().top === bounds.top && stage.getBoundingClientRect().height === bounds.height, "Reveal moved the document");
  stage.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  assert(document.body.dataset.chromeRevealed === "false" && nativeVisibility.at(-1) === false, "Leaving chrome did not hide controls");
  edge.focus();
  // Hidden windows retain DOM focus without an OS focus transition.
  edge.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  assert(document.body.dataset.chromeRevealed === "true", "Keyboard cannot reveal controls"); edge.blur(); await paint();
  chrome.configure(DEFAULT_SETTINGS); await paint();
  assert(nativeVisibility.at(-1) === true && stage.getBoundingClientRect().top === 34, "Leaving zen did not restore the frame");
  if (matchMedia("(forced-colors: active)").matches) assert(getComputedStyle(row).outlineStyle === "solid" && getComputedStyle(row).outlineWidth === "2px", "Forced colors lost the selection outline");
  return { labels: true, overflow: true, pins: true, zen: true, themes: 8 };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

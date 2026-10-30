import type { Settings } from "../shared/types.js";
import type { Bridge } from "./api.js";
import { animateChrome, exitChrome } from "./motion.js";

export function createWindowChrome(api: Pick<Bridge, "setChromeVisible"> & Partial<Pick<Bridge, "command">>) {
  const edge = document.querySelector<HTMLButtonElement>("#chrome-reveal")!;
  const isChrome = (target: EventTarget | null) => target instanceof Element && !!target.closest(".titlebar, #tabs, .pane-toolbar, #chrome-reveal");
  const hint = document.querySelector<HTMLElement>("#zen-hint")!;
  let hintTimer: number | undefined;
  let zen = false;
  let pointer = false;
  let revealed = false;
  const chrome = () => [...document.querySelectorAll<HTMLElement>(".titlebar, #tabs, .document-pane[data-active='true'] .pane-controls")].filter(node => !node.hidden && node.getBoundingClientRect().width > 0);
  const update = () => {
    const next = zen && (pointer || isChrome(document.activeElement));
    if (next === revealed) return;
    if (!next) for (const node of chrome()) exitChrome(node, "zen");
    revealed = next;
    document.body.dataset.chromeRevealed = String(next);
    if (next) for (const node of chrome()) animateChrome(node, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }]);
    api.setChromeVisible(!zen || next);
  };
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.isComposing || !zen || event.defaultPrevented) return;
    // Popovers and Find get the first Escape; the next exits zen.
    if ([...document.querySelectorAll<HTMLElement>('#picker:not([hidden]), #findbar:not([hidden]), .cm-search, .reader-options[open], dialog[open]')].some(node => node.getClientRects().length > 0)) return;
    event.preventDefault(); event.stopImmediatePropagation(); api.command?.("toggle-zen");
  }, { capture: true });
  document.addEventListener("pointerover", event => { if (zen) { pointer = isChrome(event.target); update(); } });
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => queueMicrotask(update));
  edge.addEventListener("click", () => document.querySelector<HTMLElement>('.tab[aria-selected="true"], .pane-toolbar button')?.focus());
  return {
    configure(settings: Settings) {
      if (zen === settings.zenMode) return;
      zen = settings.zenMode;
      clearTimeout(hintTimer);
      hint.hidden = !zen;
      if (zen) {
        hint.textContent = `Press Esc or ${document.body.dataset.platform === "darwin" ? "⌘⇧J" : "Ctrl+Shift+J"} to exit`;
        hintTimer = window.setTimeout(() => { hint.hidden = true; }, 4000);
      }
      pointer = false;
      if (zen && isChrome(document.activeElement)) document.querySelector<HTMLElement>('.document-pane[data-active="true"] .scroller, .document-pane[data-active="true"] .cm-content')?.focus({ preventScroll: true });
      document.body.dataset.zen = String(zen);
      revealed = false;
      document.body.dataset.chromeRevealed = "false";
      api.setChromeVisible(!zen);
    },
  };
}

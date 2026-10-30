import type { Settings } from "../shared/types.js";
import type { Bridge } from "./api.js";

export function createWindowChrome(api: Pick<Bridge, "setChromeVisible">) {
  const edge = document.querySelector<HTMLButtonElement>("#chrome-reveal")!;
  const isChrome = (target: EventTarget | null) => target instanceof Element && !!target.closest(".titlebar, #tabs, .pane-toolbar, #chrome-reveal");
  let zen = false;
  let pointer = false;
  let revealed = false;
  const update = () => {
    const next = zen && (pointer || isChrome(document.activeElement));
    if (next === revealed) return;
    revealed = next;
    document.body.dataset.chromeRevealed = String(next);
    api.setChromeVisible(!zen || next);
  };
  document.addEventListener("pointerover", event => { if (zen) { pointer = isChrome(event.target); update(); } });
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => queueMicrotask(update));
  edge.addEventListener("click", () => document.querySelector<HTMLElement>('.tab[aria-selected="true"], .pane-toolbar button')?.focus());
  return {
    configure(settings: Settings) {
      if (zen === settings.zenMode) return;
      zen = settings.zenMode;
      pointer = false;
      if (zen && isChrome(document.activeElement)) document.querySelector<HTMLElement>('.document-pane[data-active="true"] .scroller, .document-pane[data-active="true"] .cm-content')?.focus({ preventScroll: true });
      document.body.dataset.zen = String(zen);
      revealed = false;
      document.body.dataset.chromeRevealed = "false";
      api.setChromeVisible(!zen);
    },
  };
}

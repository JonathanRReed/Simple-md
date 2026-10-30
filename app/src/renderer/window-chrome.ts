import type { Settings } from "../shared/types.js";
import type { Bridge } from "./api.js";
import { animateChrome, exitChrome } from "./motion.js";

export function createWindowChrome(api: Pick<Bridge, "setChromeVisible">) {
  const edge = document.querySelector<HTMLButtonElement>("#chrome-reveal")!;
  const isChrome = (target: EventTarget | null) => target instanceof Element && !!target.closest(".titlebar, #tabs, .pane-toolbar, #chrome-reveal");
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

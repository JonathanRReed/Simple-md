import type { Settings } from "../shared/types.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const running = new Map<Animation, () => void>();
let preference: Settings["uiMotion"] = "subtle";
let ready = false;
let arming = false;
const duration = { fast: 120, move: 160, layout: 200, out: 100 };
const easing = { out: "cubic-bezier(0.2, 0, 0, 1)", spring: "cubic-bezier(0.3, 0.7, 0.2, 1)" };

export const motionEnabled = () => ready && preference === "subtle" && !reduced.matches && !document.body.classList.contains("print");
function syncPolicy(): void {
  document.documentElement.dataset.uiMotion = motionEnabled() ? "subtle" : "off";
  if (!motionEnabled()) for (const animation of [...running.keys()]) cancelChrome(animation);
}
reduced.addEventListener("change", syncPolicy);
export function configureMotion(settings: Settings): void {
  preference = settings.uiMotion;
  const css = getComputedStyle(document.documentElement);
  for (const key of ["fast", "move", "layout", "out"] as const) duration[key] = parseFloat(css.getPropertyValue(`--motion-${key}`)) || duration[key];
  easing.out = css.getPropertyValue("--motion-ease-out").trim() || easing.out;
  easing.spring = css.getPropertyValue("--motion-ease-spring").trim() || easing.spring;
  syncPolicy();
}
// Called only after first-readable has painted. No startup or first-paint motion.
export function armMotion(): void {
  if (ready || arming) return;
  arming = true;
  requestAnimationFrame(() => { ready = true; syncPolicy(); });
}

export function animateChrome(node: HTMLElement, keyframes: Keyframe[], timing: keyof typeof duration = "move", spring = false, done = () => {}): Animation | undefined {
  if (!motionEnabled()) { done(); return; }
  const animation = node.animate(keyframes, { duration: duration[timing], easing: spring ? easing.spring : easing.out });
  node.classList.add("chrome-motion");
  const finish = () => {
    if (!running.has(animation)) return;
    running.delete(animation);
    if (!node.getAnimations().some(other => running.has(other))) node.classList.remove("chrome-motion");
    done();
  };
  running.set(animation, finish);
  animation.onfinish = finish;
  animation.oncancel = finish;
  return animation;
}
function cancelChrome(animation: Animation): void {
  animation.cancel();
  running.get(animation)?.();
}

export function captureRects(nodes: Iterable<HTMLElement>): Map<HTMLElement, DOMRect> {
  if (!motionEnabled() || document.body.classList.contains("resizing-sidebar")) return new Map();
  const result = new Map([...nodes].map(node => [node, node.getBoundingClientRect()]));
  for (const node of result.keys()) for (const animation of node.getAnimations()) if (running.has(animation)) cancelChrome(animation);
  return result;
}
export function flipChrome(node: HTMLElement, before: DOMRect | undefined, enter = false): void {
  if (!motionEnabled()) return;
  for (const animation of node.getAnimations()) if (running.has(animation)) cancelChrome(animation);
  const after = node.getBoundingClientRect();
  if (!after.width || !after.height) return;
  if (before?.width && before.height) {
    if (Math.abs(before.x - after.x) + Math.abs(before.y - after.y) + Math.abs(before.width - after.width) + Math.abs(before.height - after.height) < 0.5) return;
    animateChrome(node, [
      { transform: `translate(${before.x - after.x}px, ${before.y - after.y}px) scale(${before.width / after.width}, ${before.height / after.height})`, transformOrigin: "top left" },
      { transform: "none", transformOrigin: "top left" },
    ], "move", true);
  } else if (enter) animateChrome(node, [{ opacity: 0, transform: "scale(0.96)", transformOrigin: "left center" }, { opacity: 1, transform: "none", transformOrigin: "left center" }], "move");
}

// Exit copies contain chrome only. They never retain document text or receive input.
export function exitChrome(node: HTMLElement, kind: "panel" | "tab" | "sidebar" | "zen" = "panel"): void {
  if (!motionEnabled()) return;
  if (getComputedStyle(node).visibility === "hidden") return;
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ghost = document.createElement("div");
  ghost.className = "chrome-exit";
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
  const clone = node.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return;
  clone.removeAttribute("id");
  clone.removeAttribute("role");
  for (const child of clone.querySelectorAll("[role]")) child.removeAttribute("role");
  for (const child of clone.querySelectorAll("[id]")) {
    if (child.id === "picker-input" || child.id === "picker-list") child.classList.add(child.id);
    child.removeAttribute("id");
  }
  const css = getComputedStyle(node);
  clone.style.cssText += `;position:relative;inset:auto;width:100%;height:100%;margin:0;max-width:none;visibility:visible;display:${css.display};flex-direction:${css.flexDirection};padding:${css.padding};gap:${css.gap}`;
  ghost.append(clone); document.body.append(ghost);
  const transform = { panel: "scale(0.98)", tab: "scaleX(0.01) scaleY(0.96)", sidebar: "translateX(-12px)", zen: "translateY(-4px)" }[kind];
  animateChrome(ghost, [{ opacity: 1, transform: "none" }, { opacity: 0, transform }], kind === "panel" ? "out" : kind === "sidebar" ? "layout" : "move", false, () => ghost.remove());
}

type PaneBounds = { bounds: DOMRect; documentId: string | undefined; width: number; height: number };
const paneAnimations = new Set<Animation>();
export function finishPaneMotion(): void {
  for (const animation of [...paneAnimations]) { animation.finish(); running.get(animation)?.(); }
}
export function capturePaneBounds(): Map<HTMLElement, PaneBounds> {
  // Finish an interrupted layout before measuring the next one.
  finishPaneMotion();
  if (!motionEnabled() || document.body.classList.contains("resizing-sidebar")) return new Map();
  const result = new Map<HTMLElement, PaneBounds>();
  for (const pane of document.querySelectorAll<HTMLElement>("#stage > .document-pane")) {
    const content = pane.querySelector<HTMLElement>(".pane-content")!;
    result.set(pane, { bounds: pane.querySelector<HTMLElement>(".pane-viewport")!.getBoundingClientRect(), documentId: pane.dataset.documentId, width: content.offsetWidth, height: content.offsetHeight });
  }
  return result;
}
export function flipPaneBounds(before: ReturnType<typeof capturePaneBounds>): void {
  if (!motionEnabled()) return;
  if (!before.size) return;
  for (const pane of document.querySelectorAll<HTMLElement>("#stage > .document-pane")) {
    const viewport = pane.querySelector<HTMLElement>(".pane-viewport")!;
    const content = pane.querySelector<HTMLElement>(".pane-content")!;
    const bounds = viewport.getBoundingClientRect();
    let old = before.get(pane);
    if (old && pane.dataset.documentId !== old.documentId) continue;
    if (!old) {
      const origin = [...before.values()][0]!;
      const stacked = document.querySelector<HTMLElement>("#stage")!.dataset.axis === "vertical";
      old = { bounds: new DOMRect(stacked ? bounds.x : origin.bounds.right, stacked ? origin.bounds.bottom : bounds.y, stacked ? bounds.width : 1, stacked ? 1 : bounds.height), documentId: pane.dataset.documentId, width: content.offsetWidth, height: content.offsetHeight };
    }
    if (!bounds.width || !bounds.height || !old.bounds.width || !old.bounds.height) continue;
    if (Math.abs(bounds.x - old.bounds.x) + Math.abs(bounds.y - old.bounds.y) + Math.abs(bounds.width - old.bounds.width) + Math.abs(bounds.height - old.bounds.height) < 0.5) continue;
    const sx = old.bounds.width / bounds.width, sy = old.bounds.height / bounds.height;
    const previousStyle = content.getAttribute("style");
    const overflow = pane.style.overflow;
    // The viewport clips a fixed-size document. Only its frame changes each tick.
    content.style.cssText += `;flex:none;width:${old.width}px;height:${old.height}px;transform-origin:top left`;
    pane.style.overflow = "visible";
    const frames: Keyframe[] = [], counter: Keyframe[] = [];
    for (let step = 0; step <= 200; step++) {
      const offset = step / 200, x = sx + (1 - sx) * offset, y = sy + (1 - sy) * offset;
      frames.push({ offset, transform: `translate(${(old.bounds.x - bounds.x) * (1 - offset)}px, ${(old.bounds.y - bounds.y) * (1 - offset)}px) scale(${x}, ${y})`, transformOrigin: "top left" });
      counter.push({ offset, transform: `scale(${1 / x}, ${1 / y})` });
    }
    const child = animateChrome(content, counter, "layout");
    const animation = animateChrome(viewport, frames, "layout", false, () => {
      if (child) cancelChrome(child);
      if (previousStyle === null) content.removeAttribute("style"); else content.setAttribute("style", previousStyle);
      pane.style.overflow = overflow;
      if (animation) paneAnimations.delete(animation);
    });
    if (animation) paneAnimations.add(animation);
  }
}

export function enterPanel(node: HTMLElement): void {
  for (const animation of node.getAnimations()) cancelChrome(animation);
  animateChrome(node, [{ opacity: 0, transform: "scale(0.98)" }, { opacity: 1, transform: "none" }], "fast");
}

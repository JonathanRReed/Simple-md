import { outlineIndex, outlineProgress, outlineScale, outlineScroll, outlineViewport, type OutlineItem } from "./outline-model.js";

let nextId = 0;

export function createOutlineRail<T>(options: {
  host: HTMLElement;
  scroller: HTMLElement;
  content: HTMLElement;
  items(): OutlineItem<T>[];
  offset(target: T): number;
  element?(target: T): Element;
  navigate(): void;
}) {
  const { host, scroller, content } = options;
  const abort = new AbortController();
  const signal = abort.signal;
  const rail = document.createElement("nav");
  rail.className = "outline-rail";
  rail.setAttribute("aria-label", "Outline");
  const track = document.createElement("div");
  track.className = "outline-track";
  const viewport = document.createElement("span");
  viewport.className = "outline-viewport";
  viewport.setAttribute("aria-hidden", "true");
  const tooltip = document.createElement("div");
  tooltip.className = "outline-tooltip";
  tooltip.id = `outline-tip-${++nextId}`;
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  rail.append(track, viewport, tooltip);
  host.classList.add("outline-host");
  host.append(rail);
  let items: OutlineItem<T>[] = [];
  let buttons: HTMLButtonElement[] = [];
  let offsets: number[] = [];
  let active: number | null = null;
  let frame = 0, buildFrame = 0, buildTimer = 0, measureFrame = 0;
  let destroyed = false;
  let gesture: { id: number; y: number; top: number; height: number; dragging: boolean } | null = null;
  let suppressedClick = false;
  let navigation: { kind: "heading"; key: string } | { kind: "scrub"; progress: number } | null = null;
  let ownedTop: number | null = null;
  const writeTop = (top: number) => { scroller.scrollTop = top; ownedTop = scroller.scrollTop; };
  const observed = new Map<Element, number>();
  const intersection = options.element ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const index = observed.get(entry.target);
      if (index !== undefined) markInView(index, entry.isIntersecting);
    }
  }, { root: scroller }) : null;

  function markInView(index: number, inView: boolean): void {
    const button = buttons[index];
    if (!button || button.dataset.inView === String(inView)) return;
    button.dataset.inView = String(inView);
    if (inView) button.setAttribute("aria-current", "location");
    else button.removeAttribute("aria-current");
  }

  function activate(index: number | null): void {
    if (index === active) return;
    active = index;
    buttons.forEach((button, i) => {
      button.firstElementChild?.setAttribute("style", `transform:scaleX(${outlineScale(i, active)})`);
      button.removeAttribute("aria-describedby");
    });
    const item = index === null ? undefined : items[index];
    tooltip.hidden = !item;
    if (item && index !== null) {
      tooltip.textContent = `${item.level ? `H${item.level} · ` : ""}${item.text.slice(0, 180)}${item.text.length > 180 ? "…" : ""}`;
      tooltip.style.top = `${(index + 0.5) / items.length * 100}%`;
      tooltip.style.transform = index === 0 ? "none" : index === items.length - 1 ? "translateY(-100%)" : "translateY(-50%)";
      buttons[index]?.setAttribute("aria-describedby", tooltip.id);
    }
  }

  function paintViewport(): void {
    frame = 0;
    const top = scroller.scrollTop, height = scroller.clientHeight, total = scroller.scrollHeight;
    const position = outlineViewport(top, height, total);
    viewport.style.transform = `translateY(${position.start * 100}%) scaleY(${position.size})`;
    if (!intersection) buttons.forEach((_, index) => markInView(index, offsets[index]! >= top - 1 && offsets[index]! < top + height));
  }
  function scheduleViewport(): void {
    if (!frame) frame = requestAnimationFrame(paintViewport);
  }
  function restoreNavigation(): void {
    if (!navigation) return;
    const intent = navigation;
    const index = intent.kind === "heading" ? items.findIndex(item => item.key === intent.key) : -1;
    if (intent.kind === "heading" && index < 0) { navigation = null; return; }
    writeTop(intent.kind === "scrub" ? outlineScroll(intent.progress, scroller.scrollHeight, scroller.clientHeight)
      : Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, offsets[index]! - 16)));
  }
  function stopNavigation(): void { navigation = null; ownedTop = null; }
  function jump(index: number): void {
    const item = items[index];
    if (!item) return;
    const target = options.offset(item.target);
    navigation = { kind: "heading", key: item.key };
    options.navigate();
    writeTop(Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, target - 16)));
  }

  function build(): void {
    buildTimer = 0;
    if (destroyed) return;
    const next = options.items();
    const changed = next.length !== items.length || next.some((item, index) => {
      const before = items[index]!;
      return item.key !== before.key || item.text !== before.text || item.level !== before.level;
    });
    items = next;
    // Apply the gutter before measuring. Scroll events use these cached offsets.
    scroller.classList.toggle("outline-scroll", !!items.length);
    host.classList.toggle("outline-present", !!items.length);
    offsets = items.map(item => options.offset(item.target));
    const focus = buttons.findIndex(button => button === document.activeElement);
    if (changed) {
      active = null;
      tooltip.hidden = true;
      buttons = items.map((item, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "outline-strip";
        button.tabIndex = index === Math.max(0, Math.min(focus, items.length - 1)) ? 0 : -1;
        button.setAttribute("aria-label", item.level ? `Heading level ${item.level}: ${item.text}` : item.text);
        button.dataset.level = String(item.level);
        const strip = document.createElement("span");
        strip.style.transform = `scaleX(${outlineScale(index, null)})`;
        button.append(strip);
        button.addEventListener("focus", () => activate(index));
        button.addEventListener("pointerenter", () => activate(index));
        button.addEventListener("click", event => {
          if (suppressedClick && event.detail > 0) { suppressedClick = false; return; }
          jump(index);
        });
        return button;
      });
      track.replaceChildren(...buttons);
    }
    intersection?.disconnect();
    observed.clear();
    if (intersection && options.element) items.forEach((item, index) => {
      const element = options.element!(item.target);
      observed.set(element, index);
      intersection.observe(element);
    });
    rail.hidden = !items.length;
    if (changed && focus >= 0) buttons[Math.min(focus, buttons.length - 1)]?.focus({ preventScroll: true });
    paintViewport();
  }
  function refresh(): void {
    if (buildFrame || buildTimer || destroyed) return;
    // The timer runs after the paint containing the document, including on tab switches.
    buildFrame = requestAnimationFrame(() => { buildFrame = 0; buildTimer = window.setTimeout(build, 0); });
  }
  const observer = new ResizeObserver(() => {
    if (!measureFrame) measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      offsets = items.map(item => options.offset(item.target));
      restoreNavigation();
      paintViewport();
    });
  });
  observer.observe(content);
  observer.observe(scroller);
  scroller.addEventListener("scroll", () => {
    if (ownedTop !== null && Math.abs(scroller.scrollTop - ownedTop) > 1) { navigation = null; ownedTop = null; }
    scheduleViewport();
  }, { passive: true, signal });
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) scroller.addEventListener(event, stopNavigation, { passive: true, signal });
  rail.addEventListener("wheel", event => {
    if (event.ctrlKey) return;
    options.navigate(); stopNavigation();
    const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? scroller.clientHeight : 1;
    scroller.scrollTop += event.deltaY * unit;
    event.preventDefault();
  }, { passive: false, signal });
  rail.addEventListener("pointerleave", () => { if (!rail.contains(document.activeElement) && !gesture) activate(null); }, { signal });
  rail.addEventListener("focusout", event => { if (!(event.relatedTarget instanceof Node) || !rail.contains(event.relatedTarget)) activate(null); }, { signal });
  rail.addEventListener("keydown", event => {
    const current = buttons.findIndex(button => button === document.activeElement);
    if (event.key === "Enter" || event.key === " ") {
      if (current >= 0) { event.preventDefault(); jump(current); }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); activate(null); return; }
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? Math.min(buttons.length - 1, current + 1) : event.key === "ArrowUp" ? Math.max(0, current - 1) : null;
    if (index === null) return;
    event.preventDefault();
    buttons.forEach((button, i) => { button.tabIndex = i === index ? 0 : -1; });
    buttons[index]?.focus({ preventScroll: true });
  }, { signal });
  rail.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const rect = rail.getBoundingClientRect();
    gesture = { id: event.pointerId, y: event.clientY, top: rect.top, height: rect.height, dragging: false };
    suppressedClick = false;
    // Capture on the pressed button so a stationary press still produces its normal click.
    (event.target instanceof Element ? event.target : rail).setPointerCapture(event.pointerId);
    options.navigate(); stopNavigation();
  }, { signal });
  rail.addEventListener("pointermove", event => {
    const progress = outlineProgress(event.clientY, gesture?.top ?? rail.getBoundingClientRect().top, gesture?.height ?? rail.clientHeight);
    const scrubTop = gesture ? outlineScroll(progress, scroller.scrollHeight, scroller.clientHeight) : 0;
    activate(outlineIndex(progress, items.length));
    if (!gesture || gesture.id !== event.pointerId) return;
    if (Math.abs(event.clientY - gesture.y) > 3) gesture.dragging = true;
    if (gesture.dragging) { suppressedClick = true; navigation = { kind: "scrub", progress }; writeTop(scrubTop); }
  }, { signal });
  rail.addEventListener("pointerup", event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (!gesture.dragging && event.target === rail) {
      const progress = outlineProgress(event.clientY, gesture.top, gesture.height);
      navigation = { kind: "scrub", progress };
      writeTop(outlineScroll(progress, scroller.scrollHeight, scroller.clientHeight));
    }
    gesture = null;
  }, { signal });
  for (const event of ["pointercancel", "lostpointercapture"]) rail.addEventListener(event, () => { gesture = null; }, { signal });
  refresh();
  return {
    refresh,
    destroy() {
      destroyed = true; abort.abort(); observer.disconnect(); intersection?.disconnect(); observed.clear();
      cancelAnimationFrame(frame); cancelAnimationFrame(buildFrame); cancelAnimationFrame(measureFrame); clearTimeout(buildTimer);
      scroller.classList.remove("outline-scroll"); host.classList.remove("outline-host", "outline-present"); rail.remove();
    },
  };
}

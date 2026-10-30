import { clampSidebarWidth, configSchema } from "../shared/config-schema.js";
import { tabNavigationIndex, type TabRow } from "../shared/tab-presentation.js";
import { splitTabLabel } from "../shared/tab-labels.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types.js";
import type { Bridge } from "./api.js";

export function createTabBar(strip: HTMLElement, divider: HTMLElement, api: Pick<Bridge, "activateTab" | "closeTab" | "tabContextMenu" | "setSettings" | "moveTab">) {
  let settings: Settings = DEFAULT_SETTINGS;
  let rows: TabRow[] = [];
  let previousSelected: TabRow["id"] | undefined;
  let width = configSchema["sidebar-width"].default;
  let drag: { pointer: number; x: number; width: number; direction: number } | undefined;
  let frame = 0;
  const nodes = new Map<TabRow["id"], HTMLElement>();
  let dragged: TabRow["id"] | undefined;
  const clearDrop = () => { for (const node of nodes.values()) delete node.dataset.dropBefore; };
  strip.addEventListener("dragend", () => { dragged = undefined; clearDrop(); document.body.classList.remove("dragging-tabs"); });
  strip.addEventListener("dragover", event => { if (dragged !== undefined) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; } });
  strip.addEventListener("drop", event => {
    if (dragged === undefined || event.target !== strip) return;
    event.preventDefault();
    const pinned = settings.tabStyle === "sidebar" && event.clientY < strip.getBoundingClientRect().top + 18;
    void api.moveTab(dragged, pinned, pinned ? rows.find(row => row.pinned)?.id : undefined);
  });
  const focusDocument = () => {
    const pane = document.querySelector<HTMLElement>('.document-pane[data-active="true"]');
    pane?.querySelector<HTMLElement>(pane.dataset.view === "edit" ? ".cm-content" : ".scroller")?.focus({ preventScroll: true });
  };
  const paintWidth = () => {
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    divider.setAttribute("aria-valuenow", String(width));
  };
  const cancelFrame = () => { cancelAnimationFrame(frame); frame = 0; };
  const resize = (next: number) => {
    width = clampSidebarWidth(next);
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; paintWidth(); });
  };
  const finishDrag = (persist: boolean) => {
    const previous = drag;
    if (!previous) return;
    drag = undefined;
    cancelFrame();
    if (!persist) width = clampSidebarWidth(settings.sidebarWidth);
    paintWidth();
    document.body.classList.remove("resizing-sidebar");
    if (divider.hasPointerCapture(previous.pointer)) divider.releasePointerCapture(previous.pointer);
    if (persist && width !== previous.width) void api.setSettings({ sidebarWidth: width });
  };
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    divider.focus({ preventScroll: true });
    drag = { pointer: event.pointerId, x: event.clientX, width, direction: getComputedStyle(strip).direction === "rtl" ? -1 : 1 };
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-sidebar");
  });
  divider.addEventListener("pointermove", event => {
    if (drag?.pointer === event.pointerId) resize(drag.width + (event.clientX - drag.x) * drag.direction);
  });
  divider.addEventListener("pointerup", event => {
    if (drag?.pointer !== event.pointerId) return;
    resize(drag.width + (event.clientX - drag.x) * drag.direction);
    finishDrag(true);
  });
  divider.addEventListener("pointercancel", () => finishDrag(false));
  divider.addEventListener("lostpointercapture", () => finishDrag(false));
  divider.addEventListener("dblclick", () => {
    finishDrag(false); cancelFrame(); width = configSchema["sidebar-width"].default; paintWidth();
    void api.setSettings({ sidebarWidth: width });
  });
  divider.addEventListener("keydown", event => {
    if (event.key === "Escape" && drag) { event.preventDefault(); finishDrag(false); return; }
    const def = configSchema["sidebar-width"];
    const direction = getComputedStyle(strip).direction === "rtl" ? -1 : 1;
    const step = event.shiftKey ? 10 : 1;
    const next = event.key === "ArrowRight" ? width + step * direction : event.key === "ArrowLeft" ? width - step * direction
      : event.key === "Home" ? def.min : event.key === "End" ? def.max : undefined;
    if (next === undefined) return;
    event.preventDefault(); finishDrag(false); cancelFrame(); width = clampSidebarWidth(next); paintWidth();
    void api.setSettings({ sidebarWidth: width });
  });
  function configure(next: Settings): void {
    if (drag && (settings.sidebarWidth !== next.sidebarWidth || settings.tabStyle !== next.tabStyle || settings.sidebarCollapsed !== next.sidebarCollapsed)) finishDrag(false);
    settings = next;
    if (!drag) { width = clampSidebarWidth(next.sidebarWidth); cancelFrame(); paintWidth(); }
    document.body.dataset.tabStyle = next.tabStyle;
    document.body.dataset.sidebarCollapsed = String(next.sidebarCollapsed);
    strip.setAttribute("aria-orientation", next.tabStyle === "sidebar" ? "vertical" : "horizontal");
    divider.setAttribute("aria-valuemin", String(configSchema["sidebar-width"].min));
    divider.setAttribute("aria-valuemax", String(configSchema["sidebar-width"].max));
    divider.hidden = next.tabStyle !== "sidebar" || next.sidebarCollapsed;
    strip.hidden = next.tabStyle === "sidebar" ? next.sidebarCollapsed : rows.length <= 1 && !rows.some(row => row.pinned);
    if ((strip.hidden && strip.contains(document.activeElement)) || (divider.hidden && document.activeElement === divider)) {
      focusDocument();
    }
  }
  function render(next: TabRow[]): void {
    rows = next;
    const focused = strip.contains(document.activeElement);
    for (const [id, node] of nodes) if (!rows.some(row => row.id === id)) { node.remove(); nodes.delete(id); }
    rows.forEach((row, index) => {
      let node = nodes.get(row.id);
      if (!node) {
        node = document.createElement("div"); node.className = "tab"; node.dataset.documentId = String(row.id); node.setAttribute("role", "tab");
        const title = document.createElement("span"); title.className = "tab-name";
        const short = document.createElement("span"); short.className = "tab-short"; short.setAttribute("aria-hidden", "true");
        const start = document.createElement("span"); start.className = "tab-name-start";
        const end = document.createElement("span"); end.className = "tab-name-end";
        title.append(start, end);
        const pane = document.createElement("span"); pane.className = "tab-pane"; pane.setAttribute("aria-hidden", "true");
        const dirty = document.createElement("span"); dirty.className = "tab-dirty"; dirty.setAttribute("aria-hidden", "true");
        const close = document.createElement("button"); close.type = "button"; close.className = "tab-close"; close.tabIndex = -1;
        const action = document.createElement("span"); action.className = "tab-action";
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [key, value] of Object.entries({ viewBox: "0 0 12 12", width: "12", height: "12", "aria-hidden": "true" })) icon.setAttribute(key, value);
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        for (const [key, value] of Object.entries({ d: "m3 3 6 6m0-6-6 6", fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round" })) path.setAttribute(key, value);
        icon.append(path); close.append(icon);
        close.addEventListener("click", event => { event.stopPropagation(); void api.closeTab(row.id); });
        action.append(dirty, close); node.append(pane, title, short, action);
        node.draggable = true;
        node.addEventListener("dragstart", event => {
          dragged = row.id; document.body.classList.add("dragging-tabs");
          if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-simplemd-tab", String(row.id)); }
        });
        node.addEventListener("dragover", event => {
          if (dragged === undefined) return;
          event.preventDefault(); clearDrop(); node!.dataset.dropBefore = "true";
        });
        node.addEventListener("drop", event => {
          if (dragged === undefined) return;
          event.preventDefault(); event.stopPropagation(); clearDrop();
          const target = rows.find(item => item.id === row.id)!;
          const bounds = node!.getBoundingClientRect();
          const after = settings.tabStyle === "sidebar" ? event.clientY > bounds.y + bounds.height / 2 : event.clientX > bounds.x + bounds.width / 2;
          const next = rows[rows.indexOf(target) + 1];
          void api.moveTab(dragged, target.pinned, after ? next?.pinned === target.pinned ? next.id : undefined : target.id);
        });
        node.addEventListener("click", () => void api.activateTab(row.id));
        node.addEventListener("auxclick", event => { if (event.button === 1) { event.preventDefault(); void api.closeTab(row.id); } });
        node.addEventListener("mousedown", event => { if (event.button === 1) event.preventDefault(); });
        node.addEventListener("contextmenu", event => { event.preventDefault(); void api.tabContextMenu(row.id); });
        node.addEventListener("keydown", event => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Delete") { event.preventDefault(); void api.closeTab(row.id); return; }
          const nextIndex = tabNavigationIndex(event.key, rows.findIndex(item => item.id === row.id), rows.length, settings.tabStyle);
          if (nextIndex !== undefined) { event.preventDefault(); void api.activateTab(rows[nextIndex]!.id); }
        });
        nodes.set(row.id, node);
      }
      const title = node.querySelector<HTMLElement>(".tab-name")!;
      if (title.textContent !== row.label) {
        const [start, end] = splitTabLabel(row.label);
        title.firstChild!.textContent = start; title.lastChild!.textContent = end;
      }
      node.setAttribute("aria-label", `${row.label}${row.pinned ? ", pinned" : ""}${row.dirty ? ", unsaved changes" : ""}${row.pane ? `, ${row.pane} pane` : ""}`);
      node.setAttribute("aria-selected", String(row.selected)); node.setAttribute("aria-controls", `document-${row.id}`);
      node.setAttribute("aria-keyshortcuts", "Delete"); node.tabIndex = row.selected ? 0 : -1;
      node.title = row.title; node.dataset.dirty = String(row.dirty); node.dataset.pane = row.pane ?? "";
      node.dataset.pinned = String(row.pinned);
      node.querySelector<HTMLElement>(".tab-short")!.textContent = Array.from(row.label).slice(0, 2).join("");
      node.querySelector<HTMLButtonElement>(".tab-close")!.hidden = row.pinned;
      node.querySelector<HTMLElement>(".tab-pane")!.title = row.pane ? `${row.pane} pane` : "";
      node.querySelector<HTMLElement>(".tab-dirty")!.hidden = !row.dirty;
      node.querySelector<HTMLElement>(".tab-close")!.setAttribute("aria-label", `Close ${row.label}`);
      if (strip.children[index] !== node) strip.insertBefore(node, strip.children[index] ?? null);
    });
    strip.hidden = settings.tabStyle === "sidebar" ? settings.sidebarCollapsed : rows.length <= 1 && !rows.some(row => row.pinned);
    document.body.dataset.multipleTabs = String(rows.length > 1 || rows.some(row => row.pinned));
    const selected = strip.querySelector<HTMLElement>('.tab[aria-selected="true"]');
    if (!focused && !strip.hidden && selected && rows.some(row => row.selected && row.id !== previousSelected)) requestAnimationFrame(() => { if (selected.isConnected) selected.scrollIntoView({ block: "nearest", inline: "nearest" }); });
    previousSelected = rows.find(row => row.selected)?.id;
    if (focused) {
      if (strip.hidden) { focusDocument(); return; }
      const selected = strip.querySelector<HTMLElement>('.tab[aria-selected="true"]');
      selected?.focus({ preventScroll: true }); selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  return { configure, render };
}

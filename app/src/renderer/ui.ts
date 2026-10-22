const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let toastTimer: number | undefined;

export function toast(message: string): void {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 2200);
}

export interface BannerAction {
  label: string;
  run(): void | boolean | Promise<void | boolean>;
}

export function showBanner(message: string, actions: BannerAction[]): void {
  const el = $("banner");
  el.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    b.addEventListener("click", async () => {
      for (const button of el.querySelectorAll("button")) button.disabled = true;
      try {
        const accepted = await a.run();
        if (accepted !== false && el.contains(text)) hideBanner();
      } catch {
        toast("Couldn't apply this change.");
      } finally {
        for (const button of el.querySelectorAll("button")) button.disabled = false;
      }
    });
    el.append(b);
  }
  el.hidden = false;
}

export function hideBanner(): void {
  $("banner").hidden = true;
}

// ───────── picker (command palette and outline) ─────────

export interface PickerItem {
  label: string;
  hint?: string;
  depth?: number;
  run(): void;
}

/** In-order subsequence match, scored so tighter and earlier matches rank first. */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct;
  let ti = 0;
  let total = 0;
  let last = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    total += at - last === 1 ? 4 : 1;
    last = at;
    ti = at + 1;
  }
  return total;
}

let closePicker: (() => void) | undefined;
let pickerOpen = false;
export const isPickerOpen = () => pickerOpen;

export function openPicker(placeholder: string, items: PickerItem[], onClose: () => void): void {
  closePicker?.();
  const root = $("picker");
  const input = $<HTMLInputElement>("picker-input");
  const list = $("picker-list");
  let shown: PickerItem[] = items;
  let active = 0;

  const close = () => {
    closePicker = undefined;
    pickerOpen = false;
    root.hidden = true;
    input.removeEventListener("input", render);
    input.removeEventListener("keydown", onKey);
    root.removeEventListener("mousedown", onBackdrop);
    onClose();
  };

  function render(): void {
    const q = input.value.trim();
    shown = q
      ? items
          .map((item) => ({ item, s: score(q, item.label) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.item)
      : items;
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(
      ...shown.map((item, i) => {
        const li = document.createElement("li");
        li.id = `picker-opt-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === active));
        li.style.paddingInlineStart = `${14 + (item.depth ?? 0) * 14}px`;
        const label = document.createElement("span");
        label.textContent = item.label;
        li.append(label);
        if (item.hint) {
          const hint = document.createElement("kbd");
          hint.textContent = item.hint;
          li.append(hint);
        }
        li.addEventListener("mousemove", () => {
          active = i;
          mark();
        });
        li.addEventListener("click", () => choose(i));
        return li;
      }),
    );
    input.setAttribute("aria-activedescendant", shown.length ? `picker-opt-${active}` : "");
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function mark(): void {
    list.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", `picker-opt-${active}`);
  }

  function choose(i: number): void {
    const item = shown[i];
    close();
    item?.run();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      active = Math.max(0, Math.min(shown.length - 1, active + 1));
      mark();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      active = Math.max(0, active - 1);
      mark();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target === root) close();
  }

  closePicker = close;
  pickerOpen = true;
  input.value = "";
  input.placeholder = placeholder;
  root.hidden = false;
  input.addEventListener("input", render);
  input.addEventListener("keydown", onKey);
  root.addEventListener("mousedown", onBackdrop);
  render();
  input.focus();
}

// ───────── find in the read view ─────────

let closeFind: (() => void) | undefined;
let findOpen = false;
export const isFindOpen = () => findOpen;

export function closeReadFind(): void {
  closeFind?.();
}

export function closeOverlays(): void {
  closePicker?.();
  closeFind?.();
}

export function openReadFind(onClose: () => void): void {
  if (findOpen) {
    $<HTMLInputElement>("find-input").select();
    $<HTMLInputElement>("find-input").focus();
    return;
  }
  const bar = $("findbar");
  const input = $<HTMLInputElement>("find-input");
  findOpen = true;
  bar.hidden = false;
  input.select();
  input.focus();

  const search = (backwards: boolean) => {
    if (input.value) (window as unknown as { find(q: string, c: boolean, b: boolean, w: boolean): boolean }).find(input.value, false, backwards, true);
  };
  const close = () => {
    closeFind = undefined;
    findOpen = false;
    bar.hidden = true;
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("input", onInput);
    window.getSelection()?.removeAllRanges();
    onClose();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      search(e.shiftKey);
    }
  }
  input.addEventListener("keydown", onKey);
  function onInput(): void {
    window.getSelection()?.removeAllRanges();
    search(false);
  }
  closeFind = close;
  input.addEventListener("input", onInput);
}

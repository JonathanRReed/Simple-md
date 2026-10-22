import { ZOOM_MAX, ZOOM_MIN, type Settings } from "../shared/types.js";

export interface PreferencesHandle {
  open(): void;
  sync(settings: Settings): void;
  isOpen(): boolean;
}

export function createPreferences(options: {
  platform: string;
  settings(): Settings;
  change(patch: Partial<Settings>): Promise<void>;
}): PreferencesHandle {
  const displayShortcut = (value: string) => value.split("+").map((key) => {
    switch (key.toLowerCase()) {
      case "commandorcontrol":
      case "cmdorctrl": return options.platform === "darwin" ? "Cmd" : "Ctrl";
      case "command": return "Cmd";
      case "control": return "Ctrl";
      default: return key;
    }
  }).join("+");
  const dialog = document.querySelector<HTMLDialogElement>("#preferences");
  if (!dialog) throw new Error("Preferences dialog is missing.");
  const control = <T extends HTMLElement>(id: string) => {
    const element = dialog.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Preferences control ${id} is missing.`);
    return element;
  };
  const theme = control<HTMLSelectElement>("pref-theme");
  const typeface = control<HTMLSelectElement>("pref-typeface");
  const width = control<HTMLSelectElement>("pref-width");
  const zoom = control<HTMLInputElement>("pref-zoom");
  const zoomValue = control<HTMLOutputElement>("pref-zoom-value");
  const mode = control<HTMLSelectElement>("pref-mode");
  const shortcut = control<HTMLInputElement>("pref-shortcut");
  const applyShortcut = control<HTMLButtonElement>("pref-shortcut-apply");
  const status = control<HTMLElement>("pref-status");
  const toggles = ["autosave", "vim", "spellcheck", "spacePreview", "launchAtLogin"] as const;
  let returnFocus: HTMLElement | null = null;

  function sync(settings: Settings): void {
    theme.value = settings.theme;
    typeface.value = settings.typeface;
    width.value = settings.width;
    mode.value = settings.mode;
    zoom.value = String(Math.round(settings.zoom * 100));
    zoomValue.value = `${Math.round(settings.zoom * 100)}%`;
    for (const key of toggles) control<HTMLInputElement>(`pref-${key}`).checked = settings[key];
    if (document.activeElement !== shortcut) shortcut.value = displayShortcut(settings.shortcut);
  }

  async function change(patch: Partial<Settings>, input: HTMLInputElement | HTMLSelectElement | HTMLButtonElement): Promise<void> {
    input.disabled = true;
    status.textContent = "Saving…";
    status.dataset.error = "false";
    try {
      await options.change(patch);
      sync(options.settings());
      shortcut.removeAttribute("aria-invalid");
      status.textContent = "Changes save automatically.";
    } catch (error) {
      sync(options.settings());
      if (input === applyShortcut) {
        shortcut.value = displayShortcut(options.settings().shortcut);
        shortcut.setAttribute("aria-invalid", "true");
      }
      status.dataset.error = "true";
      status.textContent = error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
        : "This preference could not be saved.";
    } finally {
      input.disabled = false;
    }
  }

  theme.addEventListener("change", () => {
    if (theme.value === "system" || theme.value === "light" || theme.value === "dark") void change({ theme: theme.value }, theme);
  });
  typeface.addEventListener("change", () => {
    if (typeface.value === "sans" || typeface.value === "serif") void change({ typeface: typeface.value }, typeface);
  });
  width.addEventListener("change", () => {
    if (width.value === "narrow" || width.value === "normal" || width.value === "wide") void change({ width: width.value }, width);
  });
  mode.addEventListener("change", () => {
    if (mode.value === "live" || mode.value === "split" || mode.value === "source") void change({ mode: mode.value }, mode);
  });
  zoom.min = String(ZOOM_MIN * 100);
  zoom.max = String(ZOOM_MAX * 100);
  zoom.addEventListener("input", () => { zoomValue.value = `${zoom.value}%`; });
  zoom.addEventListener("change", () => void change({ zoom: zoom.valueAsNumber / 100 }, zoom));
  for (const key of toggles) {
    const input = control<HTMLInputElement>(`pref-${key}`);
    input.addEventListener("change", () => void change({ [key]: input.checked }, input));
  }
  applyShortcut.addEventListener("click", () => {
    const value = shortcut.value.trim();
    if (value) void change({ shortcut: value }, applyShortcut);
    else {
      shortcut.setAttribute("aria-invalid", "true");
      status.dataset.error = "true";
      status.textContent = "Enter a shortcut before applying it.";
      shortcut.focus();
    }
  });
  shortcut.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyShortcut.click();
    }
  });
  const space = control<HTMLInputElement>("pref-spacePreview");
  space.disabled = options.platform !== "darwin";
  control<HTMLElement>("pref-space-note").textContent = options.platform === "darwin"
    ? "Preview selected Markdown files with Space in Finder. Requires Accessibility access."
    : options.platform === "win32"
      ? "Bare Space preview is unavailable on Windows. Use the global shortcut or Open with."
      : "Bare Space preview is unavailable on Linux. Use Open file or the global shortcut.";
  control<HTMLElement>("pref-shortcut-help").textContent = options.platform === "darwin"
    ? "Use Cmd, Ctrl, Option or Shift and a key. For example, Cmd+Shift+Space."
    : "Use Ctrl, Alt or Shift and a key. For example, Ctrl+Shift+Space.";
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']")]
      .filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first?.focus();
    }
  });
  dialog.addEventListener("close", () => {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  control<HTMLButtonElement>("pref-done").addEventListener("click", () => dialog.close());
  sync(options.settings());

  return {
    open() {
      if (dialog.open) return;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      sync(options.settings());
      shortcut.value = displayShortcut(options.settings().shortcut);
      shortcut.removeAttribute("aria-invalid");
      status.dataset.error = "false";
      status.textContent = "Changes save automatically.";
      dialog.showModal();
    },
    sync,
    isOpen: () => dialog.open,
  };
}

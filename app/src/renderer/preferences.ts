import { ZOOM_MAX, ZOOM_MIN, type Settings } from "../shared/types.js";

export interface PreferencesHandle {
  open(): void;
  sync(settings: Settings): void;
  isOpen(): boolean;
}

export function createPreferences(options: {
  settings(): Settings;
  change(patch: Partial<Settings>): Promise<void>;
}): PreferencesHandle {
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
  const status = control<HTMLElement>("pref-status");
  const toggles = ["autosave", "vim", "spellcheck", "launchAtLogin", "remoteImages"] as const;
  let returnFocus: HTMLElement | null = null;

  function sync(settings: Settings): void {
    theme.value = settings.theme;
    typeface.value = settings.typeface;
    width.value = settings.width;
    mode.value = settings.mode;
    zoom.value = String(Math.round(settings.zoom * 100));
    zoomValue.value = `${Math.round(settings.zoom * 100)}%`;
    for (const key of toggles) control<HTMLInputElement>(`pref-${key}`).checked = settings[key];
  }

  async function change(patch: Partial<Settings>, input: HTMLInputElement | HTMLSelectElement | HTMLButtonElement): Promise<void> {
    input.disabled = true;
    status.textContent = "Saving…";
    status.dataset.error = "false";
    try {
      await options.change(patch);
      sync(options.settings());
      status.textContent = "Changes save automatically.";
    } catch (error) {
      sync(options.settings());
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
      status.dataset.error = "false";
      status.textContent = "Changes save automatically.";
      dialog.showModal();
    },
    sync,
    isOpen: () => dialog.open,
  };
}

import { configEntries, type ConfigDefinition, type UserSettings } from "../shared/config-schema.js";
import type { SettingsBridge, SettingsSnapshot } from "../shared/settings-window.js";
declare global { interface Window { simplemdSettings: SettingsBridge } }
const bridge = window.simplemdSettings;
const form = document.querySelector<HTMLFormElement>("#settings")!;
const controls = new Map<keyof UserSettings, HTMLInputElement | HTMLSelectElement>();
let settings: UserSettings;
const labelFor = (value: string) => ({ "editorial-light": "Editorial Light", "editorial-dark": "Editorial Dark", "github-light": "GitHub Light", "github-dark": "GitHub Dark", "solarized-light": "Solarized Light", "solarized-dark": "Solarized Dark", "contrast-light": "High Contrast Light", "contrast-dark": "High Contrast Dark", system: "System", light: "Light", dark: "Dark", live: "Live", split: "Side by side", source: "Source", tab: "Tabs", window: "Windows" })[value] ?? value;
function makeControl(def: ConfigDefinition): HTMLInputElement | HTMLSelectElement {
  if (def.kind === "choice" && def.setting !== "readingStyle" || def.kind === "font") {
    const select = document.createElement("select");
    if (def.kind === "choice") for (const value of def.options) select.add(new Option(labelFor(value), value));
    return select;
  }
  const input = document.createElement("input");
  if (def.kind === "number") { input.type = "number"; input.min = String(def.min); input.max = String(def.max); input.step = "any"; }
  else input.type = "checkbox";
  return input;
}
function sync(snapshot: SettingsSnapshot): void {
  settings = snapshot.settings;
  document.documentElement.style.setProperty("--accent", snapshot.accent);
  for (const [, def] of configEntries) {
    const input = controls.get(def.setting)!;
    const value = settings[def.setting];
    if (input instanceof HTMLSelectElement && def.kind === "font") {
      const fonts = [...new Set([...snapshot.fonts, String(value)])];
      input.replaceChildren(...fonts.map(font => new Option(font, font)));
    }
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = def.setting === "readingStyle" ? value === "github" : value === true;
    else input.value = String(value);
  }
  document.querySelector("#config-path")!.textContent = snapshot.file;
  const errors = document.querySelector<HTMLElement>("#config-errors")!;
  errors.replaceChildren(...[...snapshot.issues.map(issue => `Line ${issue.line}: ${issue.message}`), ...(snapshot.fontError ? [snapshot.fontError] : [])].map(message => {
    const p = document.createElement("p"); p.textContent = message; return p;
  }));
  errors.hidden = !errors.childElementCount;
}
const groups = new Map<string, HTMLElement>();
for (const [key, def] of configEntries) {
  let group = groups.get(def.group);
  if (!group) {
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend"); legend.textContent = def.group;
    group = document.createElement("div"); group.className = "group";
    fieldset.append(legend, group); form.append(fieldset); groups.set(def.group, group);
  }
  const row = document.createElement("div"); row.className = "row";
  const label = document.createElement("label"); label.htmlFor = key; label.textContent = def.label;
  const input = makeControl(def); input.id = key; controls.set(def.setting, input);
  row.append(label, input); group.append(row);
  input.addEventListener("change", async () => {
    const error = document.querySelector<HTMLElement>("#save-error")!;
    if (!input.checkValidity()) { input.reportValidity(); return; }
    const value = def.setting === "readingStyle" && input instanceof HTMLInputElement ? (input.checked ? "github" : "editorial")
      : def.kind === "boolean" && input instanceof HTMLInputElement ? input.checked
      : def.kind === "number" && input instanceof HTMLInputElement ? input.valueAsNumber : input.value;
    input.disabled = true;
    try { sync(await bridge.set({ [def.setting]: value })); error.hidden = true; }
    catch (cause) { error.textContent = cause instanceof Error ? cause.message : "Could not save settings."; error.hidden = false; sync(await bridge.get()); }
    finally { input.disabled = false; }
  });
}
form.addEventListener("submit", event => event.preventDefault());
bridge.subscribe(sync);
void bridge.get().then(sync).catch(error => { const target = document.querySelector<HTMLElement>("#save-error")!; target.hidden = false; target.textContent = String(error); });

import { configEntries, type ConfigDefinition, type UserSettings } from "../shared/config-schema.js";
import type { SettingsBridge, SettingsSnapshot } from "../shared/settings-window.js";
declare global { interface Window { simplemdSettings: SettingsBridge } }
const bridge = window.simplemdSettings;
const form = document.querySelector<HTMLFormElement>("#settings")!;
const controls = new Map<keyof UserSettings, HTMLInputElement | HTMLSelectElement>();
let settings: UserSettings;
const labelFor = (value: string) => ({ "editorial-light": "Editorial Light", "editorial-dark": "Editorial Dark", "github-light": "GitHub Light", "github-dark": "GitHub Dark", "solarized-light": "Solarized Light", "solarized-dark": "Solarized Dark", "contrast-light": "High Contrast Light", "contrast-dark": "High Contrast Dark", system: "System", light: "Light", dark: "Dark", live: "Live", split: "Side by side", source: "Source", tab: "Tabs", window: "Windows", top: "Horizontal", sidebar: "Sidebar", repo: "Repository", everywhere: "Everywhere" })[value] ?? value;
function makeControl(def: ConfigDefinition): HTMLInputElement | HTMLSelectElement {
  if (def.kind === "choice" && def.setting !== "readingStyle" && def.setting !== "uiMotion" || def.kind === "font") {
    const select = document.createElement("select");
    if (def.kind === "choice") for (const value of def.options) select.add(new Option(labelFor(value), value));
    return select;
  }
  const input = document.createElement("input");
  if (def.kind === "number") { input.type = "number"; input.min = String(def.min); input.max = String(def.max); input.step = String(def.step < 1 ? 0.01 : def.step); }
  else { input.type = "checkbox"; input.setAttribute("role", "switch"); }
  return input;
}
function sync(snapshot: SettingsSnapshot): void {
  settings = snapshot.settings;
  document.documentElement.style.setProperty("--accent", snapshot.accent);
  document.documentElement.style.colorScheme = settings.theme === "system" ? "light dark" : settings.theme;
  for (const [, def] of configEntries) {
    const input = controls.get(def.setting)!;
    const value = settings[def.setting];
    input.disabled = def.group === "Reading" && settings.readingStyle === "github";
    input.title = input.disabled ? "GitHub style fixes reading typography. Switch it off to change these values." : "";
    if (input instanceof HTMLSelectElement && def.kind === "font") {
      const fonts = [...new Set([...snapshot.fonts, String(value)])];
      input.replaceChildren(...fonts.map(font => new Option(font, font)));
    }
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = def.setting === "readingStyle" ? value === "github" : def.setting === "uiMotion" ? value === "subtle" : value === true;
    else input.value = String(value);
  }
  document.querySelector<HTMLElement>("#reading-style-note")!.hidden = settings.readingStyle !== "github";
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
  const label = document.createElement("label"); label.htmlFor = key; label.textContent = def.setting === "theme" ? "Color scheme" : def.label.replace(/ \(.*\)/, "");
  const input = makeControl(def); input.id = key; controls.set(def.setting, input);
  const control = document.createElement("span"); control.className = "control";
  control.append(input);
  if (input instanceof HTMLSelectElement) control.classList.add("popup");
  if (def.kind === "number" && /\(.*\)/.test(def.label)) {
    const unit = document.createElement("span"); unit.className = "unit"; unit.id = `${key}-unit`;
    unit.textContent = def.label.includes("(px)") ? "px" : "characters";
    input.setAttribute("aria-describedby", unit.id); control.append(unit);
  }
  if (def.group === "Reading") input.setAttribute("aria-describedby", `${input.getAttribute("aria-describedby") ?? ""} reading-style-note`.trim());
  row.append(label, control); group.append(row);
  input.addEventListener("change", async () => {
    const error = document.querySelector<HTMLElement>("#save-error")!;
    if (def.group === "Reading" && settings.readingStyle === "github") return;
    if (!input.checkValidity()) { input.reportValidity(); return; }
    const value = def.setting === "readingStyle" && input instanceof HTMLInputElement ? (input.checked ? "github" : "editorial")
      : def.setting === "uiMotion" && input instanceof HTMLInputElement ? (input.checked ? "subtle" : "off")
      : def.kind === "boolean" && input instanceof HTMLInputElement ? input.checked
      : def.kind === "number" && input instanceof HTMLInputElement ? input.valueAsNumber : input.value;
    const restoreFocus = document.activeElement === input;
    input.disabled = true;
    try { sync(await bridge.set({ [def.setting]: value })); error.hidden = true; }
    catch (cause) { error.textContent = cause instanceof Error ? cause.message : "Could not save settings."; error.hidden = false; sync(await bridge.get()); }
    finally { input.disabled = def.group === "Reading" && settings.readingStyle === "github"; if (restoreFocus && document.activeElement === document.body) input.focus(); }
  });
}
const readingNote = document.createElement("p");
readingNote.id = "reading-style-note";
readingNote.textContent = "GitHub style fixes reading font, size, line height and width. Switch it off to change them. Zoom still enlarges the page.";
groups.get("Reading")!.append(readingNote);
const advanced = document.createElement("fieldset");
const advancedTitle = document.createElement("legend"); advancedTitle.textContent = "Advanced";
const advancedGroup = document.createElement("div"); advancedGroup.className = "group advanced";
const configButton = document.createElement("button"); configButton.type = "button"; configButton.textContent = "Config file";
configButton.setAttribute("aria-expanded", "false"); configButton.setAttribute("aria-controls", "config-details");
const configDetails = document.querySelector<HTMLElement>("footer")!;
configDetails.id = "config-details"; configDetails.hidden = true;
configButton.addEventListener("click", () => { configDetails.hidden = !configDetails.hidden; configButton.setAttribute("aria-expanded", String(!configDetails.hidden)); });
advancedGroup.append(configButton, configDetails); advanced.append(advancedTitle, advancedGroup); form.append(advanced);
form.addEventListener("submit", event => event.preventDefault());
bridge.subscribe(sync);
void bridge.get().then(sync).catch(error => { const target = document.querySelector<HTMLElement>("#save-error")!; target.hidden = false; target.textContent = String(error); });

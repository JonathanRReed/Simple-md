const choice = <T extends string>(setting: string, label: string, group: string, value: T, options: readonly T[]) =>
  ({ setting, label, group, kind: "choice" as const, default: value, options });
const number = (setting: string, label: string, group: string, value: number, min: number, max: number, step: number) =>
  ({ setting, label, group, kind: "number" as const, default: value, min, max, step });
const boolean = (setting: string, label: string, group: string, value: boolean) =>
  ({ setting, label, group, kind: "boolean" as const, default: value });
const font = (setting: string, label: string, group: string, value: string) =>
  ({ setting, label, group, kind: "font" as const, default: value });

// This table owns config keys, runtime values, validation, controls and documentation.
export const configSchema = {
  "theme-light": { ...choice("themeLight", "Light theme", "Appearance", "editorial-light", ["editorial-light", "github-light", "solarized-light", "contrast-light"]), setting: "themeLight" },
  "theme-dark": { ...choice("themeDark", "Dark theme", "Appearance", "editorial-dark", ["editorial-dark", "github-dark", "solarized-dark", "contrast-dark"]), setting: "themeDark" },
  "appearance": { ...choice("theme", "Appearance", "Appearance", "system", ["system", "light", "dark"]), setting: "theme" },
  "reading-style": { ...choice("readingStyle", "GitHub style", "Appearance", "editorial", ["editorial", "github"]), setting: "readingStyle" },
  "reading-font-family": { ...font("readingFontFamily", "Font", "Reading", "Charter"), setting: "readingFontFamily" },
  "reading-font-size": { ...number("readingFontSize", "Size (px)", "Reading", 19, 10, 40, 1), setting: "readingFontSize" },
  "reading-line-height": { ...number("readingLineHeight", "Line height", "Reading", 1.68, 1, 2.5, 0.05), setting: "readingLineHeight" },
  "content-width": { ...number("contentWidth", "Width (characters)", "Reading", 66, 40, 160, 1), setting: "contentWidth" },
  "writing-font-family": { ...font("writingFontFamily", "Font", "Writing", "system-ui"), setting: "writingFontFamily" },
  "writing-font-size": { ...number("writingFontSize", "Size (px)", "Writing", 17, 10, 40, 1), setting: "writingFontSize" },
  "writing-line-height": { ...number("writingLineHeight", "Line height", "Writing", 1.65, 1, 2.5, 0.05), setting: "writingLineHeight" },
  "writing-content-width": { ...number("writingContentWidth", "Width (characters)", "Writing", 66, 40, 160, 1), setting: "writingContentWidth" },
  "code-font-family": { ...font("codeFontFamily", "Font", "Code", "ui-monospace"), setting: "codeFontFamily" },
  "code-font-size": { ...number("codeFontSize", "Size (px)", "Code", 14, 10, 40, 1), setting: "codeFontSize" },
  "code-line-height": { ...number("codeLineHeight", "Line height", "Code", 1.55, 1, 2.5, 0.05), setting: "codeLineHeight" },
  "code-content-width": { ...number("codeContentWidth", "Width (characters)", "Code", 100, 40, 200, 1), setting: "codeContentWidth" },
  "mode": { ...choice("mode", "Editing mode", "Behavior", "live", ["live", "split", "source"]), setting: "mode" },
  "open-quickly-scope": { ...choice("openQuicklyScope", "Open Quickly scope", "Behavior", "repo", ["repo", "everywhere"]), setting: "openQuicklyScope" },
  "open-in": { ...choice("openIn", "Open files in", "Behavior", "tab", ["tab", "window"]), setting: "openIn" },
  "tab-style": { ...choice("tabStyle", "Tab style", "Tabs", "top", ["top", "sidebar"]), setting: "tabStyle" },
  "sidebar-width": { ...number("sidebarWidth", "Sidebar width (px)", "Tabs", 220, 160, 420, 1), setting: "sidebarWidth" },
  "sidebar-collapsed": { ...boolean("sidebarCollapsed", "Hide tab sidebar", "Tabs", false), setting: "sidebarCollapsed" },
  "autosave": { ...boolean("autosave", "Autosave", "Behavior", true), setting: "autosave" },
  "vim": { ...boolean("vim", "Vim key bindings", "Behavior", false), setting: "vim" },
  "spellcheck": { ...boolean("spellcheck", "Spellcheck", "Behavior", true), setting: "spellcheck" },
  "remote-images": { ...boolean("remoteImages", "Remote images", "Behavior", true), setting: "remoteImages" },
  "launch-at-login": { ...boolean("launchAtLogin", "Launch at login", "Behavior", false), setting: "launchAtLogin" },
} as const;
export type ConfigKey = keyof typeof configSchema;
export type ConfigDefinition = (typeof configSchema)[ConfigKey];
export type UserSettings = { -readonly [K in ConfigKey as (typeof configSchema)[K]["setting"]]: (typeof configSchema)[K]["default"] };
export const configEntries = Object.entries(configSchema) as [ConfigKey, ConfigDefinition][];
export const configDefaults = Object.fromEntries(configEntries.map(([, def]) => [def.setting, def.default])) as UserSettings;
export function clampSidebarWidth(width: number): number {
  const def = configSchema["sidebar-width"];
  return Number.isFinite(width) ? Math.min(def.max, Math.max(def.min, Math.round(width))) : def.default;
}
export function normalizeConfigValue<T>(def: ConfigDefinition, value: T): T | number {
  return def.setting === "sidebarWidth" && typeof value === "number" && Number.isFinite(value) ? clampSidebarWidth(value) : value;
}
export function isConfigKey(key: string): key is ConfigKey { return Object.hasOwn(configSchema, key); }
export function validConfigValue(def: ConfigDefinition, value: unknown): boolean {
  switch (def.kind) {
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value) && value >= def.min && value <= def.max;
    case "choice": return typeof value === "string" && def.options.some(option => option === value);
    case "font": return typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
  }
}

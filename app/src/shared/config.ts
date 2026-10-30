import { configDefaults, configEntries, configSchema, isConfigKey, normalizeConfigValue, validConfigValue, type ConfigKey, type UserSettings } from "./config-schema.js";
export interface ConfigIssue { line: number; key: string; message: string }
export interface ConfigDocument { source: string; settings: UserSettings; issues: ConfigIssue[] }
function valueAndComment(raw: string): { value: string; comment: string } {
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (char === "#" && !quoted) {
      const before = raw.slice(0, i);
      return { value: before.trim(), comment: before.slice(before.trimEnd().length) + raw.slice(i) };
    }
  }
  return { value: raw.trim(), comment: raw.slice(raw.trimEnd().length) };
}
function decode(value: string): unknown {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return Number(value);
  return value;
}
export function parseConfig(source: string): ConfigDocument {
  const settings = { ...configDefaults };
  const issues: ConfigIssue[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(?:#.*)?$/.test(line)) return;
    const match = line.match(/^\s*([\w-]+)\s*=\s*(.*)$/);
    const key = match?.[1] ?? "";
    const issue = (message: string) => issues.push({ line: index + 1, key, message });
    if (!match) { issue("Expected key = value."); return; }
    if (key === "zen-mode") return; // Retired session toggle. Old config files remain valid.
    if (!isConfigKey(key)) { issue(`Unknown key: ${key}.`); return; }
    const def = configSchema[key];
    try {
      const value = normalizeConfigValue(def, decode(valueAndComment(match[2]!).value));
      if (!validConfigValue(def, value)) { issue(`Invalid value for ${key}.`); return; }
      Object.assign(settings, { [def.setting]: value });
    } catch { issue(`Invalid value for ${key}.`); }
  });
  return { source, settings, issues };
}
export function encodeConfigValue(value: UserSettings[keyof UserSettings]): string {
  return typeof value === "string" && !/^[\w.-]+$/.test(value) ? JSON.stringify(value) : String(value);
}
// Only patched keys change. Other bytes, including unknown and invalid lines, survive.
export function serializeConfig(source: string, patch: Partial<UserSettings>): string {
  const changed = new Map<ConfigKey, UserSettings[keyof UserSettings]>();
  for (const [key, def] of configEntries) {
    const value = normalizeConfigValue(def, patch[def.setting]);
    if (value === undefined) continue;
    if (!validConfigValue(def, value)) throw new TypeError(`Invalid value for ${key}.`);
    changed.set(key, value);
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const seen = new Set<ConfigKey>();
  let result = source.replace(/[^\r\n]+/g, line => {
    const match = line.match(/^(\s*)([\w-]+)(\s*=\s*)(.*)$/);
    if (!match || !isConfigKey(match[2]!)) return line;
    const key = match[2];
    if (!changed.has(key)) return line;
    seen.add(key);
    return `${match[1]}${key}${match[3]}${encodeConfigValue(changed.get(key)!)}${valueAndComment(match[4]!).comment}`;
  });
  for (const [key, value] of changed) {
    if (seen.has(key)) continue;
    if (result && !result.endsWith("\n")) result += eol;
    result += `${key} = ${encodeConfigValue(value)}${eol}`;
  }
  return result;
}
export function validateUserPatch(raw: unknown): Partial<UserSettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Expected settings.");
  const patch: Partial<UserSettings> = {};
  for (const [setting, value] of Object.entries(raw)) {
    const entry = configEntries.find(([, def]) => def.setting === setting);
    if (!entry) throw new TypeError(`Invalid setting: ${setting}.`);
    const normalized = normalizeConfigValue(entry[1], value);
    if (!validConfigValue(entry[1], normalized)) throw new TypeError(`Invalid setting: ${setting}.`);
    Object.assign(patch, { [setting]: normalized });
  }
  return patch;
}

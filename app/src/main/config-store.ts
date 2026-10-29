import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseConfig, serializeConfig, type ConfigDocument, type ConfigIssue } from "../shared/config.js";
import { configEntries, type UserSettings } from "../shared/config-schema.js";
import type { Settings } from "../shared/types.js";
export function configPath(options: { platform: NodeJS.Platform; home: string; appData: string; env: NodeJS.ProcessEnv }): string {
  if (options.env.SMD_USER_DATA) return path.join(options.env.SMD_USER_DATA, "config");
  if (options.platform === "win32") return path.join(options.appData, "SimpleMD", "config");
  return path.join(options.env.XDG_CONFIG_HOME || path.join(options.home, ".config"), "simplemd", "config");
}
export function migrateUserSettings(raw: unknown, legacy: Settings): UserSettings {
  const result = Object.fromEntries(configEntries.map(([, def]) => [def.setting, legacy[def.setting]])) as UserSettings;
  if (raw && typeof raw === "object") {
    if ("typeface" in raw) result.readingFontFamily = legacy.typeface === "sans" ? "system-ui" : "Charter";
    if ("width" in raw) result.contentWidth = { narrow: 54, normal: 66, wide: 100 }[legacy.width];
  }
  return result;
}
export class ConfigStore {
  document: ConfigDocument;
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  constructor(readonly file: string, initial: UserSettings, private report: (issues: ConfigIssue[]) => void = issues => {
    for (const issue of issues) console.error(`simplemd config:${issue.line}: ${issue.message}`);
  }) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      try { fs.writeFileSync(file, serializeConfig("# SimpleMD\n", initial), { flag: "wx", mode: 0o600 }); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    }
    this.document = this.read();
    this.report(this.document.issues);
  }
  private read(): ConfigDocument {
    try { return parseConfig(fs.readFileSync(this.file, "utf8")); }
    catch (error) { return { ...parseConfig(""), issues: [{ line: 0, key: "", message: `Cannot read config: ${error instanceof Error ? error.message : String(error)}` }] }; }
  }
  set(patch: Partial<UserSettings>): UserSettings {
    const source = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
    const next = serializeConfig(source, patch);
    if (next !== source) {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const mode = fs.existsSync(this.file) ? fs.statSync(this.file).mode & 0o777 : 0o600;
        fs.writeFileSync(temporary, next, { flag: "wx", mode });
        fs.renameSync(temporary, this.file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    this.document = this.read();
    this.report(this.document.issues);
    return this.document.settings;
  }
  watch(onChange: (settings: UserSettings) => void): void {
    this.watcher = fs.watch(path.dirname(this.file), { persistent: false }, (_event, name) => {
      if (name && name.toString() !== path.basename(this.file)) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const next = this.read();
        if (next.source === this.document.source && JSON.stringify(next.issues) === JSON.stringify(this.document.issues)) return;
        this.document = next;
        this.report(next.issues);
        onChange(next.settings);
      }, 70);
      this.timer.unref();
    });
    this.watcher.on("error", error => {
      this.document.issues = [{ line: 0, key: "", message: `Config watcher failed: ${error.message}` }];
      this.report(this.document.issues);
      onChange(this.document.settings);
    });
  }
  close(): void { clearTimeout(this.timer); this.watcher?.close(); }
}

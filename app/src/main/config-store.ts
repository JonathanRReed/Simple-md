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
function readConfigSource(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Config must be a regular file.");
    if (stat.size >= 1_000_000) throw new Error("Config must be under 1 MB.");
    const bytes = Buffer.alloc(1_000_000);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) return bytes.subarray(0, length).toString("utf8");
      length += count;
    }
    throw new Error("Config must be under 1 MB.");
  } finally { fs.closeSync(fd); }
}
export class ConfigStore {
  document: ConfigDocument;
  private stopWatching?: () => void;
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
    try { return parseConfig(readConfigSource(this.file)); }
    catch (error) { return { ...parseConfig(""), issues: [{ line: 0, key: "", message: `Cannot read config: ${error instanceof Error ? error.message : String(error)}` }] }; }
  }
  set(patch: Partial<UserSettings>): UserSettings {
    const source = fs.existsSync(this.file) ? readConfigSource(this.file) : "";
    const next = serializeConfig(source, patch);
    if (next !== source) {
      const target = fs.existsSync(this.file) ? fs.realpathSync(this.file) : this.file;
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const mode = fs.existsSync(this.file) ? fs.statSync(this.file).mode & 0o777 : 0o600;
        fs.writeFileSync(temporary, next, { flag: "wx", mode });
        fs.renameSync(temporary, target);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    this.document = this.read();
    this.report(this.document.issues);
    return this.document.settings;
  }
  watch(onChange: (settings: UserSettings) => void): void {
    const reload = () => {
      const next = this.read();
      if (next.source === this.document.source && JSON.stringify(next.issues) === JSON.stringify(this.document.issues)) return;
      this.document = next;
      this.report(next.issues);
      onChange(next.settings);
    };
    const changed = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(reload, 70);
      this.timer.unref();
    };
    // Stat watching survives atomic replacement and missing files on every platform.
    fs.watchFile(this.file, { persistent: false, interval: 500 }, changed);
    this.stopWatching = () => fs.unwatchFile(this.file, changed);
    // Cover an edit made while the watcher is taking its initial stat snapshot.
    changed();
  }

  close(): void { clearTimeout(this.timer); this.stopWatching?.(); }
}

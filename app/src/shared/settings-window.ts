import type { UserSettings } from "./config-schema.js";
import type { ConfigIssue } from "./config.js";
export interface SettingsSnapshot {
  settings: UserSettings;
  issues: ConfigIssue[];
  file: string;
  fonts: string[];
  fontError?: string;
  accent: string;
}
export interface SettingsBridge {
  action(action: "default-app" | "open-config" | "reveal-config"): Promise<void>;
  get(): Promise<SettingsSnapshot>;
  set(patch: Partial<UserSettings>): Promise<SettingsSnapshot>;
  subscribe(callback: (snapshot: SettingsSnapshot) => void): () => void;
}

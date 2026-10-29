export type ThemeSetting = "system" | "light" | "dark";
export type EditMode = "live" | "split" | "source";
export type ReadingWidth = "narrow" | "normal" | "wide";
export type Typeface = "sans" | "serif";

export interface Settings {
  theme: ThemeSetting;
  shortcut: string;
  mode: EditMode;
  autosave: boolean;
  /** Press Space on a Markdown file in Finder to preview it. Needs the native helper. */
  spacePreview: boolean;
  /** Keep SimpleMD resident so Space is instant; the app lives in the tray, not the Dock. */
  launchAtLogin: boolean;
  /** Modal editing in the source modes. */
  vim: boolean;
  spellcheck: boolean;
  remoteImages: boolean;
  /** The one-time permission explainer has been shown. */
  peekPrompted: boolean;
  zoom: number;
  width: ReadingWidth;
  typeface: Typeface;
  recents: string[];
  bounds?: { x: number; y: number; width: number; height: number };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  shortcut: "CommandOrControl+Shift+Space",
  // Live is the default because it asks nothing of the user: write, and it renders in place.
  mode: "live",
  autosave: true,
  spacePreview: true,
  peekPrompted: false,
  launchAtLogin: false,
  vim: false,
  spellcheck: true,
  remoteImages: true,
  zoom: 1,
  width: "normal",
  typeface: "sans",
  recents: [],
};

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.8;

/** "peek" opens read-only like Quick Look; "edit" goes straight into the editor. */
export type OpenIntent = "peek" | "edit";

export type { RenderedBlock } from "./render-core.js";
import type { RenderedBlock } from "./render-core.js";

export interface DocPayload {
  documentId: number;
  path: string | null;
  name: string;
  text: string;
  blocks: RenderedBlock[];
  title: string;
  intent: OpenIntent;
  /** file: URL of the document's folder with a trailing slash, for resolving relative images. */
  baseUrl: string | null;
}

export interface FlushResult {
  documentId: number;
  conflict: boolean;
  dirty: boolean;
  text: string;
}

export interface SaveResult {
  documentId: number;
  path: string;
  name: string;
  baseUrl: string;
  text: string;
}

export type Command =
  | "preferences"
  | "new"
  | "save"
  | "save-as"
  | "toggle-edit"
  | "mode-live"
  | "mode-split"
  | "mode-source"
  | "undo"
  | "redo"
  | "find"
  | "palette"
  | "outline"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "export-pdf"
  | "export-html"
  | "print"
  | "nav-back"
  | "nav-forward"
  | "toggle-task"
  | "reveal"
  | "format-bold"
  | "format-italic"
  | "format-code"
  | "format-link"
  | "format-strike";

/** Above this many characters the Live Preview is switched off so typing stays instant. */
export const LIVE_MAX_CHARS = 250_000;

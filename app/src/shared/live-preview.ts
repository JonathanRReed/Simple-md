import { LIVE_MAX_CHARS, type EditMode } from "./types.js";

export function livePreviewOff(length: number, mode: EditMode = "live", gitCommit = false): boolean {
  return !gitCommit && mode === "live" && length > LIVE_MAX_CHARS;
}

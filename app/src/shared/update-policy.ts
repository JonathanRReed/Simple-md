export const updateInterval = 24 * 60 * 60 * 1000;
export type UpdateGate = {
  packaged: boolean;
  platform: NodeJS.Platform;
  signed: boolean;
  appImage: boolean;
  enabled: boolean;
  manual: boolean;
  now: number;
  lastCheck: number;
};
export function updateDecision(gate: UpdateGate): "check" | "development" | "unsigned" | "unsupported" | "disabled" | "recent" {
  if (!gate.packaged) return "development";
  if (gate.platform === "darwin" && !gate.signed) return "unsigned";
  if (gate.platform === "linux" && !gate.appImage || !["darwin", "win32", "linux"].includes(gate.platform)) return "unsupported";
  if (gate.manual) return "check";
  if (!gate.enabled) return "disabled";
  if (gate.lastCheck > 0 && gate.now - gate.lastCheck < updateInterval) return "recent";
  return "check";
}

export type UpdateState =
  | { kind: "idle" | "checking" | "current" | "downloading" | "ready" | "installing" }
  | { kind: "error"; message: string };
export function updateMenu(state: UpdateState, downloaded: boolean) {
  const status = state.kind === "error" ? state.message : ({ idle: "", checking: "Checking…", current: "Up to Date", downloading: "Downloading…", ready: "Ready to Install", installing: "Preparing to Restart…" }[state.kind]);
  return {
    checkLabel: status ? `Check for Updates: ${status}` : "Check for Updates…",
    checkEnabled: !["checking", "downloading", "installing"].includes(state.kind),
    installEnabled: downloaded && !["checking", "downloading", "installing"].includes(state.kind),
  };
}

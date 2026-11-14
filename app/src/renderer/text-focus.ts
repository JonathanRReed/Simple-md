/** Native menu commands arrive through IPC, so forward input history to Chromium. */
export function inputHistory(command: "undo" | "redo"): boolean {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || target.closest(".cm-content")) return false;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) return false;
  document.execCommand(command);
  return true;
}

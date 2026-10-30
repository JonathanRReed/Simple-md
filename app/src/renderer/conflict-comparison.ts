/** Plain text keeps incoming HTML and MDX inert, including in the comparison. */
export function showConflictComparison(local: string, incoming: string): () => void {
  const restore = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "conflict-comparison";
  dialog.setAttribute("aria-label", "Incoming changes");
  const header = document.createElement("header");
  const title = document.createElement("h2"); title.textContent = "Incoming changes";
  const done = document.createElement("button"); done.type = "button"; done.textContent = "Done";
  const close = () => { dialog.close(); dialog.remove(); if (restore instanceof HTMLElement && restore.isConnected) restore.focus({ preventScroll: true }); };
  done.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  header.append(title, done);
  const columns = document.createElement("div"); columns.className = "conflict-columns";
  const panes: HTMLPreElement[] = [];
  for (const [label, text] of [["Your version", local], ["On disk", incoming]]) {
    const section = document.createElement("section");
    const heading = document.createElement("h3"); heading.textContent = label!;
    const pre = document.createElement("pre"); pre.tabIndex = 0; pre.setAttribute("aria-label", label!); pre.textContent = text!;
    section.append(heading, pre); columns.append(section); panes.push(pre);
  }
  // Synchronize proportional positions without feeding the programmatic scroll back.
  let driver: HTMLPreElement | undefined;
  for (const pre of panes) {
    for (const event of ["wheel", "pointerdown", "keydown", "touchstart"]) pre.addEventListener(event, () => { driver = pre; }, { passive: true });
    pre.addEventListener("scroll", () => {
      if (driver !== pre) return;
      const progress = pre.scrollTop / Math.max(1, pre.scrollHeight - pre.clientHeight);
      for (const other of panes) if (other !== pre) other.scrollTop = progress * (other.scrollHeight - other.clientHeight);
    }, { passive: true });
  }
  dialog.append(header, columns); document.body.append(dialog); dialog.showModal(); done.focus();
  return close;
}

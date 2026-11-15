/** Only keyboard traversal paints the reader ring; opening a document also focuses it. */
export function readerFocus(scroller: HTMLElement): () => void {
  const events = new AbortController();
  let tabbing = false;
  const key = (event: KeyboardEvent) => { tabbing = event.key === "Tab" && !event.isComposing; };
  const clear = () => { tabbing = false; delete scroller.dataset.keyboardFocus; };
  document.addEventListener("keydown", key, { capture: true, signal: events.signal });
  document.addEventListener("focusin", event => { if (event.target !== scroller) tabbing = false; }, { capture: true, signal: events.signal });
  document.addEventListener("pointerdown", clear, { capture: true, signal: events.signal });
  scroller.addEventListener("focus", () => { if (tabbing) scroller.dataset.keyboardFocus = "true"; tabbing = false; }, { signal: events.signal });
  scroller.addEventListener("blur", clear, { signal: events.signal });
  return () => events.abort();
}

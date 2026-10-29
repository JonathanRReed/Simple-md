export const runBatch = async (css: string) => {
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);
  document.body.innerHTML = `<div id="tabs"><div class="tab" role="tab" aria-selected="true">Selected</div></div><div id="stage" data-panes="2"><div class="document-pane" data-active="true"><div class="pane-toolbar"></div></div><div class="document-pane" data-active="false"><div class="pane-toolbar"></div></div></div>`;
  const selected = getComputedStyle(document.querySelector(".tab")!);
  const active = getComputedStyle(document.querySelector('[data-active="true"] .pane-toolbar')!, "::before");
  const inactive = getComputedStyle(document.querySelector('[data-active="false"] .pane-toolbar')!, "::before");
  return { selectedShape: selected.boxShadow !== "none" || selected.borderBottomWidth !== "0px", activeShape: active.visibility !== inactive.visibility || active.content !== inactive.content || active.borderLeftWidth !== inactive.borderLeftWidth };
};
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

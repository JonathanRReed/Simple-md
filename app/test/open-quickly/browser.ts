import { openQuickly } from "../../src/renderer/open-quickly";
import { closeOverlays } from "../../src/renderer/ui";
import { rankQuicklyFiles, type QuicklyFile, type QuicklyMatch } from "../../src/shared/open-quickly";

async function runBatch(): Promise<unknown> {
  document.body.dataset.platform = "darwin";
  document.body.innerHTML = '<button id="restore">Document</button><div id="picker" hidden><div class="picker-card"><input id="picker-input" role="combobox" aria-controls="picker-list"><ul id="picker-list" role="listbox"></ul></div></div><div id="toast"></div>';
  document.querySelector<HTMLButtonElement>("#restore")!.focus();
  const input = document.querySelector<HTMLInputElement>("#picker-input")!;
  const files: QuicklyFile[] = [{ path: "/docs/README.md", source: "tab" }, { path: "/docs/guide.mdx", source: "recent" }];
  const opens: unknown[] = [], scopes: string[] = [];
  let closes = 0;
  const pending: ((matches: QuicklyMatch[]) => void)[] = [];
  let listener: ((request: number, matches: QuicklyMatch[]) => void) | undefined;
  const api = {
    quicklyQuery: (_query: string, scope: string) => { scopes.push(scope); return new Promise<QuicklyMatch[]>(resolve => pending.push(resolve)); },
    quicklyOpen: async (file: string, otherPane: boolean) => { opens.push({ file, otherPane }); return true; },
    quicklyClose: () => { closes++; },
    onQuicklyResults: (cb: (request: number, matches: QuicklyMatch[]) => void) => { listener = cb; return () => { listener = undefined; }; },
  };
  const key = (key: string, metaKey = false) => input.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey, bubbles: true, cancelable: true }));
  const query = (text: string) => { input.value = text; input.dispatchEvent(new Event("input")); };
  openQuickly(api, "repo", files);
  const immediate = document.querySelectorAll('[role="option"]').length;
  const aria = { role: input.getAttribute("role"), controls: input.getAttribute("aria-controls"), expanded: input.getAttribute("aria-expanded"), label: input.getAttribute("aria-label") };
  key("ArrowDown"); const down = input.getAttribute("aria-activedescendant");
  key("ArrowUp"); const up = input.getAttribute("aria-activedescendant");
  query("rdm");
  const highlights = [...document.querySelectorAll("mark")].map(x => x.textContent).join("");
  query("guide");
  pending[1]?.(rankQuicklyFiles(files, "rdm")); await Promise.resolve();
  const staleIgnored = document.querySelector('[role="option"] > span')?.textContent;
  key("Tab"); const scope = document.querySelector(".picker-scope")?.textContent;
  key("Enter", true);
  const restored = document.activeElement?.id;
  pending.at(-1)?.(rankQuicklyFiles(files, "")); await Promise.resolve();
  const hiddenAfterReply = document.querySelector<HTMLElement>("#picker")!.hidden;
  openQuickly(api, "repo", files);
  const remembered = document.querySelector(".picker-scope")?.textContent;
  key("Enter");
  openQuickly(api, "repo", files); query("not-found"); key("ArrowDown");
  const emptyActive = input.getAttribute("aria-activedescendant"); key("Enter");
  const staysOpen = !document.querySelector<HTMLElement>("#picker")!.hidden; key("Escape");
  openQuickly(api, "repo", files); closeOverlays();
  return { immediate, aria, down, up, highlights, staleIgnored, scope, scopes, opens, restored, hiddenAfterReply, remembered, emptyActive, staysOpen, closes, unsubscribed: listener === undefined };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

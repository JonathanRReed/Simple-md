import type { Bridge } from "./api.js";
import { mergeQuicklyFiles, rankQuicklyFiles, type QuicklyFile, type QuicklyScope } from "../shared/open-quickly.js";
import { openPicker, toast, type PickerItem } from "./ui.js";

let sessionScope: QuicklyScope | undefined;
export function openQuickly(api: Pick<Bridge, "quicklyOpen" | "quicklyClose" | "quicklyQuery" | "onQuicklyResults">, defaultScope: QuicklyScope, instant: QuicklyFile[], initialQuery = ""): void {
  let scope = sessionScope ?? defaultScope;
  let request = 0, closed = false;
  const restore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const items = (matches: ReturnType<typeof rankQuicklyFiles>): PickerItem[] => matches.map(file => ({
    label: file.name, labelIndices: file.nameIndices, parent: file.parent, parentIndices: file.parentIndices,
    run: otherPane => { void api.quicklyOpen(file.path, !!otherPane).then(opened => { if (!opened) toast("Couldn't open this file."); }).catch(() => toast("Couldn't open this file.")); },
  }));
  let updateResults: ((items: PickerItem[]) => void) | undefined;
  const unsubscribe = api.onQuicklyResults((current, matches) => { if (!closed && current === request) updateResults?.(items(matches)); });
  openPicker("Open Quickly", [], () => {
    closed = true; request++; unsubscribe(); api.quicklyClose();
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }, {
    initialQuery, scope,
    toggleScope: () => sessionScope = scope = scope === "repo" ? "everywhere" : "repo",
    search: (query, update) => {
      const current = ++request; updateResults = update;
      const local = scope === "repo" ? instant.map(file => ({ ...file, matchPath: file.path.split(/[\\/]/).at(-1) ?? file.path })) : instant;
      update(items(rankQuicklyFiles(mergeQuicklyFiles([local], document.body.dataset.platform === "win32"), query)));
      void api.quicklyQuery(query, scope, current).then(matches => {
        if (!closed && current === request) update(items(matches));
      }).catch(() => {});
    },
  });
}

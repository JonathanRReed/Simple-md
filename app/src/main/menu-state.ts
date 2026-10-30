import type { GitChangesStatus } from "../shared/change-highlights.js";
import type { Settings, ViewMode } from "../shared/types.js";
export function changesMenuState(hasDocumentPath: boolean, status?: GitChangesStatus) {
  return {
    enabled: hasDocumentPath,
    checked: hasDocumentPath && status?.available === true && status.active,
    toolTip: status?.available === false ? status.reason : "Compare this file with Git HEAD",
  };
}
export function menuState(settings: Settings, mode: ViewMode, hasDocumentPath: boolean, gitStatus?: GitChangesStatus) {
  const { recents, autosave, spellcheck, vim, theme, readingStyle, launchAtLogin, tabStyle, sidebarCollapsed } = settings;
  return {
    application: JSON.stringify({ recents, mode, autosave, spellcheck, vim, theme, readingStyle, tabStyle, sidebarCollapsed, hasDocumentPath, changes: changesMenuState(hasDocumentPath, gitStatus) }),
    tray: JSON.stringify({ mode: settings.mode, theme, launchAtLogin }),
    recents: JSON.stringify(recents),
  };
}

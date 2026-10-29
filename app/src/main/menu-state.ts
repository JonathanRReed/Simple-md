import type { GitChangesStatus } from "../shared/change-highlights.js";
import type { Settings } from "../shared/types.js";
export function changesMenuState(hasDocumentPath: boolean, status?: GitChangesStatus) {
  return {
    enabled: hasDocumentPath,
    checked: hasDocumentPath && status?.available === true && status.active,
    toolTip: status?.available === false ? status.reason : "Compare this file with Git HEAD",
  };
}
export function menuState(settings: Settings, mode: Settings["mode"], hasDocumentPath: boolean, gitStatus?: GitChangesStatus) {
  const { recents, autosave, spellcheck, vim, theme, readingStyle, launchAtLogin } = settings;
  return {
    application: JSON.stringify({ recents, mode, autosave, spellcheck, vim, theme, readingStyle, hasDocumentPath, changes: changesMenuState(hasDocumentPath, gitStatus) }),
    tray: JSON.stringify({ mode: settings.mode, theme, launchAtLogin }),
    recents: JSON.stringify(recents),
  };
}

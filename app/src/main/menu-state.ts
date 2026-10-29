import type { GitChangesStatus } from "../shared/change-highlights.js";
import type { Settings } from "../shared/types.js";
export function menuState(settings: Settings, mode: Settings["mode"], canShare: boolean, gitStatus?: GitChangesStatus) {
  const { recents, autosave, spellcheck, vim, theme, readingStyle, launchAtLogin } = settings;
  return {
    application: JSON.stringify({ recents, mode, autosave, spellcheck, vim, theme, readingStyle, canShare, gitStatus }),
    tray: JSON.stringify({ mode: settings.mode, theme, launchAtLogin }),
    recents: JSON.stringify(recents),
  };
}

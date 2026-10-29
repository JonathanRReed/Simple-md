import type { Settings } from "../shared/types.js";
export function menuState(settings: Settings, mode: Settings["mode"], canShare: boolean) {
  const { recents, autosave, spellcheck, vim, theme, readingStyle, launchAtLogin } = settings;
  return {
    application: JSON.stringify({ recents, mode, autosave, spellcheck, vim, theme, readingStyle, canShare }),
    tray: JSON.stringify({ mode: settings.mode, theme, launchAtLogin }),
    recents: JSON.stringify(recents),
  };
}

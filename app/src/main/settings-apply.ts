import type { Settings } from "../shared/types.js";
import { patchSettings } from "./settings-store.js";

/** Config reloads always commit the remaining settings even if the OS rejects login changes. */
export function applySettings(current: Settings, patch: unknown, persist: boolean, actions: {
  login(enabled: boolean): void;
  persist(next: Settings, patch: unknown): Settings;
  commit(next: Settings, previous: Settings): void;
}): Error | undefined {
  try {
    let next = patchSettings(current, patch);
    let failure: Error | undefined;
    if (next.launchAtLogin !== current.launchAtLogin || persist && patch !== null && typeof patch === "object" && Object.hasOwn(patch, "launchAtLogin")) {
      try { actions.login(next.launchAtLogin); }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    }
    if (persist) next = actions.persist(next, patch);
    actions.commit(next, current);
    return failure;
  } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

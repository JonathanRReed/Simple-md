const MODIFIERS = new Map([
  ["commandorcontrol", "CommandOrControl"], ["cmdorctrl", "CommandOrControl"],
  ["command", "Command"], ["cmd", "Command"], ["control", "Control"], ["ctrl", "Control"],
  ["alt", "Alt"], ["option", "Alt"], ["altgr", "AltGr"], ["shift", "Shift"], ["super", "Super"], ["meta", "Super"],
]);
const KEYS = new Map([
  "Plus", "Space", "Tab", "Capslock", "Numlock", "Scrolllock", "Backspace", "Delete", "Insert", "Return",
  "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Escape", "VolumeUp", "VolumeDown", "VolumeMute",
  "MediaNextTrack", "MediaPreviousTrack", "MediaStop", "MediaPlayPause", "PrintScreen", "numdec", "numadd", "numsub", "nummult", "numdiv",
].map((key) => [key.toLowerCase(), key]));
KEYS.set("enter", "Return");
KEYS.set("esc", "Escape");
const MODIFIER_ORDER = [...new Set(MODIFIERS.values())];

export function normalizeShortcut(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Enter a shortcut, such as CommandOrControl+Shift+Space.");
  let source = value.trim();
  if (source === "+") source = "Plus";
  else if (source.endsWith("++")) source = source.slice(0, -1) + "Plus";
  const parts = source.split("+").map((part) => part.trim());
  const rawKey = parts.pop() ?? "";
  const lowerKey = rawKey.toLowerCase();
  const key = KEYS.get(lowerKey) ?? (/^[a-z0-9]$/i.test(rawKey) ? rawKey.toUpperCase() :
    /^(?:f(?:[1-9]|1[0-9]|2[0-4])|num[0-9])$/i.test(rawKey) ? rawKey.toUpperCase() :
    rawKey.length === 1 && ')!@#$%^&*(:;=<?,_->.?/~`{][|\\}"'.includes(rawKey) ? rawKey : undefined);
  if (!key) throw new Error("Use one key and valid shortcut modifiers.");
  const modifiers = parts.map((part) => MODIFIERS.get(part.toLowerCase()));
  if (modifiers.some((modifier) => modifier === undefined) || new Set(modifiers).size !== modifiers.length) {
    throw new Error("Use valid modifiers once each, such as Control+Shift+Space.");
  }
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)), key].join("+");
}

export function replaceShortcut(
  previous: string | null,
  candidate: unknown,
  shortcuts: { register(value: string, callback: () => void): boolean; unregister(value: string): void },
  callback: () => void,
): string {
  const next = normalizeShortcut(candidate);
  if (next === previous) return next;
  let registered: boolean;
  try {
    registered = shortcuts.register(next, callback);
  } catch {
    throw new Error("That shortcut is invalid or unavailable. The previous shortcut is still active.");
  }
  if (!registered) throw new Error("That shortcut is unavailable. Choose another shortcut.");
  if (previous) shortcuts.unregister(previous);
  return next;
}

import { defaultKeymap } from "@codemirror/commands";

// App navigation, formatting, pane layout and change navigation own these keys.
// Indentation remains on Tab/Shift-Tab and Mod-Alt-\; line movement remains Alt-Up/Down.
const appKeys = new Set(["Mod-i", "Mod-[", "Mod-]", "Shift-Mod-\\", "Mod-Alt-ArrowUp", "Mod-Alt-ArrowDown"]);
export const writingDefaultKeymap = defaultKeymap.filter(binding => !appKeys.has(binding.key ?? "") && !appKeys.has(binding.mac ?? "")).map(binding => binding.key === "Alt-ArrowLeft" || binding.key === "Alt-ArrowRight" ? { ...binding, key: undefined } : binding);

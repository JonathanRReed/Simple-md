import { expect, test } from "bun:test";
import { commandAccelerator, commandDefinition, commandDefinitions, shortcutHint } from "../src/shared/commands";
import { writingDefaultKeymap } from "../src/renderer/editor-bindings";
import { parseConfig, serializeConfig } from "../src/shared/config";
test("shared command table has unique IDs and shortcuts on each platform", () => {
  expect(new Set(commandDefinitions.map(command => command.id)).size).toBe(commandDefinitions.length);
  for (const mac of [true, false]) {
    const used = new Set<string>();
    for (const command of commandDefinitions) {
      if (!mac && command.macOnly) continue;
      const key = shortcutHint(commandAccelerator(command, mac), mac);
      if (!key) continue;
      expect(used.has(key)).toBe(false); used.add(key);
    }
  }
  expect(shortcutHint(commandAccelerator(commandDefinition("block-heading-3")!, true), true)).toBe("⌃⌘3");
  expect(shortcutHint(commandAccelerator(commandDefinition("find-replace")!, false), false)).toBe("Ctrl+H");
  for (const command of commandDefinitions) if (command.id.startsWith("block-heading-") || command.id === "block-body") expect(commandAccelerator(command, true)).toMatch(/^Control\+Command\+[0-6]$/);
  expect(commandAccelerator(commandDefinition("go-to-line")!, true)).toBe("Control+G");
});
test("CodeMirror yields collisions to the app and keeps macOS movement and Tab indentation", () => {
  const keys = writingDefaultKeymap.flatMap(binding => [binding.key, binding.mac]);
  for (const key of ["Mod-i", "Mod-[", "Mod-]", "Shift-Mod-\\", "Mod-Alt-ArrowUp", "Mod-Alt-ArrowDown"]) expect(keys).not.toContain(key);
  expect(writingDefaultKeymap.some(binding => binding.key === "Alt-ArrowLeft" || binding.key === "Alt-ArrowRight")).toBe(false);
  for (const key of ["Alt-ArrowLeft", "Alt-ArrowRight", "Ctrl-a", "Ctrl-e", "Ctrl-k", "Ctrl-h", "Ctrl-b", "Ctrl-f", "Ctrl-n", "Ctrl-p", "Mod-Alt-\\", "Ctrl-ArrowLeft", "Ctrl-ArrowRight"]) expect(keys).toContain(key);
});
test("image-folder is the only new setting and validates safe relative folders", () => {
  expect(parseConfig(serializeConfig("", { imageFolder: "public/images/posts" })).settings.imageFolder).toBe("public/images/posts");
  expect(parseConfig("").settings.imageFolder).toBe("assets");
  for (const value of ["../outside", "/tmp", "a\\b", "a//b", "a/./b", "C:/outside"]) expect(parseConfig(`image-folder = ${JSON.stringify(value)}`).issues).toHaveLength(1);
});

import path from "node:path";
import { configDefaults, configEntries } from "../src/shared/config-schema";
import { encodeConfigValue, serializeConfig } from "../src/shared/config";
const rows = configEntries.map(([key, def]) => {
  const values = def.kind === "choice" ? def.options.join(", ") : def.kind === "number" ? `${def.min} to ${def.max}` : def.kind === "font" ? "Installed font family or CSS generic family" : "true, false";
  return `| \`${key}\` | \`${encodeConfigValue(def.default)}\` | ${values} |`;
});
const output = `# SimpleMD config

Generated from \`app/src/shared/config-schema.ts\`. Regenerate with \`cd app && bun scripts/generate-config-docs.ts\`.

Settings and the config file update each other live. Open Settings from the application menu, the tray, the Read view Aa control or Command/Control-comma.

On macOS and Linux, the file is \`$XDG_CONFIG_HOME/simplemd/config\`, or \`~/.config/simplemd/config\` when XDG_CONFIG_HOME is unset. On Windows it is \`%APPDATA%\\SimpleMD\\config\`. Isolated development profiles use \`$SMD_USER_DATA/config\`.

Use one \`key = value\` per line. Lines beginning with \`#\` are comments. Inline comments are allowed outside double quotes. Quote font names containing spaces or \`#\`. Quoted strings use JSON escapes. Booleans are \`true\` or \`false\`, and numeric values are decimal numbers. The last valid occurrence of a repeated key wins.

Settings preserves comments, unknown lines, line endings and ordering. Changing a repeated key updates each occurrence. Unknown keys, malformed lines and invalid values appear in Settings with line numbers and are logged. Invalid values leave the default in effect, or the preceding valid occurrence of that key. Fix the file to clear the errors. File deletion reports an error and applies defaults until the file is recreated.

| Key | Default | Accepted values |
| --- | --- | --- |
${rows.join("\n")}

The default appearance follows the system and selects the configured light or dark theme. Theme colors apply only to the document. Chrome, focus and selection use the system accent. GitHub style fixes reading typography at 16px system UI, line height 1.5 and a maximum width of 980px. Settings disables the reading font, size, line height and width controls while GitHub style is active, since those values have no effect. Config values remain saved and apply again when you switch back. Zoom still enlarges GitHub pages. Writing and code typography remain independent. Widths use characters of the selected font; code blocks scroll horizontally when needed. No fonts are bundled for these roles. KaTeX retains its math fonts.

Tabs appear across the top by default. Set tab-style = sidebar for a list of open documents on the leading edge. Drag its divider to resize, use Left and Right when the divider has focus, or double-click to reset to 220 px. sidebar-width clamps to 160 through 420 px. View > Show/Hide Tab Sidebar uses Control-Command-S on macOS and Control-Alt-S elsewhere, where Control-Shift-S remains Save As. sidebar-collapsed saves the hidden state. These settings apply to every open window without reloading documents.

Files open in Read unless they have no extension, are named COMMIT_EDITMSG, use --wait or target a :line. Those open in Source. The mode setting chooses the view when you deliberately start editing.

On first run, existing settings.json preferences migrate to config if config does not exist. Explicit legacy sans/serif and narrow/normal/wide choices map to reading font and width. Existing config wins. After the next state save, settings.json contains only recent paths, window bounds and zoom. Zoom remains transient application state and scales the configured font sizes. The earlier Simple-md profile migration still copies settings and recents, not caches. Launch at login changes system registration only in packaged builds, as before. The open-in setting is shared with the tabs milestone.

## Example

\`\`\`ini
${serializeConfig("# SimpleMD\n", configDefaults).trimEnd()}
\`\`\`
`;
const file = path.resolve(import.meta.dir, "../../docs/config.md");
const exampleFile = path.resolve(import.meta.dir, "../../docs/config.example");
const example = serializeConfig("# SimpleMD\n", configDefaults);
if (process.argv.includes("--check")) {
  if (await Bun.file(exampleFile).text() !== example) throw new Error("Regenerate docs/config.example from the config schema.");
  if (await Bun.file(file).text() !== output) throw new Error("Regenerate docs/config.md from the config schema.");
} else { await Bun.write(file, output); await Bun.write(exampleFile, example); }

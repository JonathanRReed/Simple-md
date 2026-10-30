# SimpleMD config

Generated from `app/src/shared/config-schema.ts`. Regenerate with `cd app && bun scripts/generate-config-docs.ts`.

Settings and the config file update each other live. Open Settings from the application menu, the tray, the Read view Aa control or Command/Control-comma.

On macOS and Linux, the file is `$XDG_CONFIG_HOME/simplemd/config`, or `~/.config/simplemd/config` when XDG_CONFIG_HOME is unset. On Windows it is `%APPDATA%\SimpleMD\config`. Isolated development profiles use `$SMD_USER_DATA/config`.

Use one `key = value` per line. Lines beginning with `#` are comments. Inline comments are allowed outside double quotes. Quote font names containing spaces or `#`. Quoted strings use JSON escapes. Booleans are `true` or `false`, and numeric values are decimal numbers. The last valid occurrence of a repeated key wins.

Settings preserves comments, unknown lines, line endings and ordering. Changing a repeated key updates each occurrence. Unknown keys, malformed lines and invalid values appear in Settings with line numbers and are logged. Invalid values leave the default in effect, or the preceding valid occurrence of that key. Fix the file to clear the errors. File deletion reports an error and applies defaults until the file is recreated.

| Key | Default | Accepted values |
| --- | --- | --- |
| `theme-light` | `editorial-light` | editorial-light, github-light, solarized-light, contrast-light |
| `theme-dark` | `editorial-dark` | editorial-dark, github-dark, solarized-dark, contrast-dark |
| `appearance` | `system` | system, light, dark |
| `reading-style` | `editorial` | editorial, github |
| `reading-font-family` | `Charter` | Installed font family or CSS generic family |
| `reading-font-size` | `19` | 10 to 40 |
| `reading-line-height` | `1.68` | 1 to 2.5 |
| `content-width` | `66` | 40 to 160 |
| `outline-rail` | `true` | true, false |
| `outline-rail-levels` | `3` | 1 to 6 |
| `writing-font-family` | `system-ui` | Installed font family or CSS generic family |
| `writing-font-size` | `17` | 10 to 40 |
| `writing-line-height` | `1.65` | 1 to 2.5 |
| `writing-content-width` | `66` | 40 to 160 |
| `code-font-family` | `ui-monospace` | Installed font family or CSS generic family |
| `code-font-size` | `14` | 10 to 40 |
| `code-line-height` | `1.55` | 1 to 2.5 |
| `code-content-width` | `100` | 40 to 200 |
| `mode` | `live` | live, split, source |
| `open-quickly-scope` | `repo` | repo, everywhere |
| `open-in` | `tab` | tab, window |
| `tab-style` | `top` | top, sidebar |
| `sidebar-width` | `180` | 140 to 420 |
| `sidebar-collapsed` | `false` | true, false |
| `zen-mode` | `false` | true, false |
| `ui-motion` | `subtle` | subtle, off |
| `autosave` | `true` | true, false |
| `vim` | `false` | true, false |
| `spellcheck` | `true` | true, false |
| `remote-images` | `true` | true, false |
| `launch-at-login` | `false` | true, false |

The default appearance follows the system and selects the configured light or dark theme. Theme colors apply only to the document. Chrome, focus and selection use the system accent. GitHub style fixes reading typography at 16px system UI, line height 1.5 and a maximum width of 980px. Settings disables the reading font, size, line height and width controls while GitHub style is active, since those values have no effect. Config values remain saved and apply again when you switch back. Zoom still enlarges GitHub pages. Writing and code typography remain independent. Widths use characters of the selected font; code blocks scroll horizontally when needed. No fonts are bundled for these roles. KaTeX retains its math fonts.

Tabs appear across the top by default. Set tab-style = sidebar for a list of open documents on the leading edge. Drag its divider to resize, use Left and Right when the divider has focus, or double-click to reset to 180 px. sidebar-width clamps to 140 through 420 px. View > Show/Hide Tab Sidebar uses Control-Command-S on macOS and Control-Alt-S elsewhere, where Control-Shift-S remains Save As. sidebar-collapsed saves the hidden state. These settings apply to every open window without reloading documents. The search button before horizontal tabs and the field below the sidebar window controls open Open Quickly. View controls sit at the trailing end of the top row in both layouts.

Open Quickly uses Command/Control-Shift-O. Tab cycles This repo and Everywhere; the choice lasts for the window session. open-quickly-scope sets the initial scope and defaults to repo. Enter opens a tab, even with open-in = window. Command/Control-Enter opens in the other pane. Existing files focus their tabs. Outline moves to Command/Control-Alt-Shift-O; Command/Control-P remains Print.

Open Quickly searches tabs and recents immediately, then queries Git on demand. Outside a repository it walks the active document's folder, up to six levels and 20,000 entries, skipping hidden directories, node_modules and symlinks. Everywhere also queries Spotlight on macOS or an existing plocate/locate database on Linux. Windows currently searches tabs, recents and the repository or folder only. Missing Linux search tools leave those same sources available. Nothing starts a crawler or writes an index. Closing the finder cancels searches and clears its file list. Search processes have a 10-second timeout and an 8 MB output cap; the picker shows at most 200 results. Machine results exclude Library, app bundles and cache directories.

View > Zen Mode uses Command-Shift-J on macOS and Control-Shift-J elsewhere. zen-mode saves the choice. The top edge reveals controls without shifting the document. Pinned files and their order live in settings.json, not this config. Only existing pinned files reopen on launch.

ui-motion = subtle enables brief chrome transitions after the first document paint. ui-motion = off or the system Reduce Motion preference makes changes instant. Document text, reading position and first paint never animate. Settings provides a Subtle chrome motion switch.

Files open in Read unless they have no extension, are named COMMIT_EDITMSG, use --wait or target a :line. Those open in Source. The mode setting chooses the view when you deliberately start editing.

On first run, existing settings.json preferences migrate to config if config does not exist. Explicit legacy sans/serif and narrow/normal/wide choices map to reading font and width. Existing config wins. After the next state save, settings.json contains only recent paths, pinned paths, window bounds and zoom. Zoom remains transient application state and scales the configured font sizes. The earlier Simple-md profile migration still copies settings and recents, not caches. Launch at login changes system registration only in packaged builds, as before. The open-in setting is shared with the tabs milestone.

## Example

```ini
# SimpleMD
theme-light = editorial-light
theme-dark = editorial-dark
appearance = system
reading-style = editorial
reading-font-family = Charter
reading-font-size = 19
reading-line-height = 1.68
content-width = 66
outline-rail = true
outline-rail-levels = 3
writing-font-family = system-ui
writing-font-size = 17
writing-line-height = 1.65
writing-content-width = 66
code-font-family = ui-monospace
code-font-size = 14
code-line-height = 1.55
code-content-width = 100
mode = live
open-quickly-scope = repo
open-in = tab
tab-style = top
sidebar-width = 180
sidebar-collapsed = false
zen-mode = false
ui-motion = subtle
autosave = true
vim = false
spellcheck = true
remote-images = true
launch-at-login = false
```

# Roadmap

Simple-md is becoming **SimpleMD**: a fast, small, native-feeling reader and editor for Markdown and MDX on macOS and Windows, with Linux to follow. Think Ghostty, but for `.md` files.

## v1.0

- **Saves exactly what you typed.** Line endings, BOM and spacing stay intact. MDX files become fully editable, and nothing in them ever runs.
- **Renders like GitHub.** Safe raw HTML, `<details>`, matching heading anchors, emoji, math, diagrams, and dark/light images. A test corpus of real READMEs checks this.
- **Fast by measurement.** Recorded performance gates for cold launch, warm open, the first screen of huge files, typing latency and memory.
- **Tabs and a two-pane split** in one light window, plus native menus, context menus and sharing.
- **Make it yours.** Curated light and dark themes, an editorial or GitHub reading style, reading/writing/code fonts, and a plain-text config file that syncs with Preferences.
- **Terminal friendly.** A `simplemd` command for opening files, reading from stdin, `--wait` as your `$EDITOR`, jumping to a line or heading, and exporting.
- **Watches files for you.** When another tool rewrites an open file, the changes are highlighted until you have seen them.
- **Previews in the file manager.** A Quick Look extension and thumbnails on macOS, and an Explorer preview pane on Windows.
- **Signed macOS releases** with auto-update and a Homebrew tap. Windows signing is pending SignPath approval; winget follows.

## Not planned

SimpleMD will not have a vault or file tree, AI features, a WYSIWYG document model, plugins, or publishing integrations. It stays one file at a time and fast.

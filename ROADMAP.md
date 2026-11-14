# Roadmap

SimpleMD targets Markdown and MDX on macOS 13 or later on Apple Silicon and Windows x64. Linux runtime qualification follows v1.0. This list describes the v1.0 goals, not completed release checks.

## v1.0

- **Saves exactly what you typed.** Line endings, BOM and spacing stay intact. MDX files become fully editable, and nothing in them ever runs.
- **Renders like GitHub.** Safe raw HTML, `<details>`, matching heading anchors, emoji, math, diagrams, and dark/light images. A test corpus of real READMEs checks this.
- **Fast by measurement.** Recorded performance gates for cold launch, warm open, the first screen of huge files, typing latency and memory.
- **Tabs and a two-pane split** in one light window, plus native menus, context menus and sharing.
- **Make it yours.** Curated light and dark themes, an editorial or GitHub reading style, reading/writing/code fonts, and a plain-text config file that syncs with Settings.
- **Terminal friendly.** A `simplemd` command for opening files, reading from stdin, `--wait` as your `$EDITOR`, jumping to a line or heading, and exporting.
- **Watches files for you.** When another tool rewrites an open file, the changes are highlighted until you have seen them.
- **Previews in the file manager.** A Quick Look extension and thumbnails on macOS, and an Explorer preview pane on Windows.
- **Distribution.** Signed and notarized macOS releases, Windows signing through SignPath or an explicit unsigned fallback, automatic updates, then Homebrew and winget publication. Packaging and update tooling exist; published downloads and package-manager availability require owner release steps.

## Not planned

SimpleMD will not have a vault or file tree, AI features, a WYSIWYG document model, plugins, or publishing integrations. It stays one file at a time and fast.

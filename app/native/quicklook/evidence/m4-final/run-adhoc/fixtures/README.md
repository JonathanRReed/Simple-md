# SimpleMD

A Markdown viewer and editor for macOS, Windows, and Linux. The current app lives in [`app/`](app/). It uses Electron, TypeScript, Bun, and a Rust helper for macOS save metadata.

Choose Live, Source, or Side by side editing for Markdown and MDX. Read with syntax highlighting, math, diagrams, and local images. MDX imports stay hidden in read view. Components and expressions appear as inert placeholders.

Open **Preferences** from the app menu, toolbar, or Command/Control+, to change the theme, editing defaults, text size, autosave, Vim, spelling, and launch behavior. Changes save automatically.

Settings and recent documents migrate automatically from the old profile, without caches. You can remove an old Simple-md.app or Windows install by hand.

## Develop

Use Bun 1.4.3 or newer, Node.js 24, and a native Rust toolchain with edition 2024 support. Windows native builds also need the MSVC C++ build tools. Linux needs a graphical desktop and Electron's system libraries to run the app.

From the repository root:

```sh
bun run setup          # install app dependencies from app/bun.lock
bun run build:native   # build the helper for this machine
bun run start          # build and launch Electron
```

Root commands forward to `app/`:

```sh
bun run typecheck
bun run test
bun run test:packaging
bun run check:rust
bun run test:rust
bun run build
bun run pack:plan      # inspect the host and unsigned packaging settings
bun run pack           # build an unpacked app under app/release/
bun run dist           # build unsigned artifacts under app/release/
```

`pack` and `dist` build only for the current platform and architecture. They disable signing identity discovery, Developer ID signing, Windows signing, notarization, and publishing. They can download Electron and packaging tools. They do not install the app or create a release.

See the [app guide](app/README.md) for controls, platform limits, packaging, and validation. Windows and Linux runtime behavior still needs verification on those operating systems. Cross-platform source code and CI configuration do not establish that the installed app works there.

## File-manager previews

macOS previews use the Quick Look preview and thumbnail extensions described in [the integration spec](docs/specs/quick-look.md). The app has no Finder keyboard hook and requests no Accessibility or Automation permission. Quick Look packaging and fixture qualification are separate from the app cleanup.

On Windows and Linux, open notes through File > Open, Open With, file associations, or an explicit command-line file path. The old preview-only global shortcut is removed. The app stays resident in the tray for warm opens; Launch at Login is optional. See [Linux integration](app/integrations/linux/README.md).

## License

[MIT](LICENSE). Copyright 2026 Jonathan Ray Reed. The license also ships in packaged app resources.

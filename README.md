# SimpleMD

A Markdown viewer and editor for macOS 13 or later on Apple Silicon and Windows x64. Linux builds are experimental and remain unqualified until after v1.0. The current app lives in [`app/`](app/). It uses Electron, TypeScript, Bun, and a Rust helper for macOS save metadata.

Choose Live, Source, or Side by side editing for Markdown and MDX. Read with syntax highlighting, math, diagrams, and local images. MDX imports stay hidden in read view. Components and expressions appear as inert placeholders.

Open Quickly with Command/Control+Shift+O finds Markdown and MDX files in the active repository or across your machine. Tab switches between This repo and Everywhere. Enter opens a tab; Command/Control+Enter opens in the other pane. Open files focus their existing tabs. Machine search uses Spotlight on macOS and an existing locate database on Linux. Windows currently searches tabs, recents and the repo. Print remains Command/Control+P.

The Format menu adds headings, lists, tasks, quotes, code blocks, footnotes, images and table editing as plain edits to the Markdown source. Copy As puts Markdown, HTML or formatted text on the clipboard, and Paste as Markdown converts copied web content. File actions include Duplicate, Rename or Move, Copy Path and Reopen Closed Tab. See the [app guide](app/README.md) for the full list and shortcuts.

Open **Settings** from the app menu, toolbar, or Command/Control+, to change the theme, editing defaults, text size, autosave, Vim, spelling, and launch behavior. Changes save automatically.

Settings and recent documents migrate automatically from the old profile, without caches. You can remove an old Simple-md.app or Windows install by hand.

## Install

Supported builds target macOS 13 or later on Apple Silicon and Windows 10 or later on x64. Intel Macs and Windows ARM64 are unsupported. The Windows minimum follows [Electron's platform support](https://github.com/electron/electron/blob/main/README.md#platform-support). Linux builds have no runtime qualification yet.

When a release is published, choose the installer for your system on [Releases](https://github.com/JonathanRReed/Simple-md/releases). On macOS, open the DMG, move SimpleMD to Applications, then launch it there. On Windows, run the x64 installer for your user account.

To make SimpleMD the default on macOS, select an `.md` file in Finder, choose Get Info > Open with > SimpleMD > Change All. Repeat for `.markdown` and `.mdx`. On Windows, use Settings > Apps > Default apps, find each extension and choose SimpleMD. Repeat for any other Markdown extensions you use.

Quick Look selection is separate from the default app. If another previewer is installed, search System Settings for Quick Look and enable SimpleMD's preview extension. Current macOS versions place this under General > Login Items & Extensions. Custom thumbnail routing remains unqualified. Quick Look's open action follows the selected opener, so choose SimpleMD as the default to open previews in SimpleMD.

Closing a document window keeps SimpleMD in the menu bar or system tray for warm opens. To exit, choose SimpleMD > Quit SimpleMD on macOS or File > Quit on Windows. Launch at Login is optional and off by default; disable it in Settings before uninstalling.

For terminal use on macOS, first move the app to Applications, then choose SimpleMD > Install Command Line Tool. If it installs to `~/.local/bin`, add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file and open a new terminal. Windows installation adds the CLI folder to your user PATH; open a new terminal afterward. See [CLI installation and link repair](docs/cli.md#install) if the command is missing or the app moved. Raycast and Alfred scripts need the installed CLI's absolute path if their environment lacks that folder on PATH.

See [Releases and updates](#releases-and-updates) below for update controls and unsigned Windows installation steps.

To uninstall on macOS, quit SimpleMD and move it from Applications to Trash. Remove the CLI symlink only after checking that it points into the removed app. To remove local settings too, delete `~/.config/simplemd` and `~/Library/Application Support/SimpleMD`, or your custom XDG config location. On Windows, use Settings > Apps > Installed apps > SimpleMD > Uninstall. The uninstaller removes the CLI PATH entry and preview registration. To remove saved settings too, delete `%APPDATA%\SimpleMD`. Your Markdown files remain where you saved them.

## Develop

Use the pinned Bun 1.4.4, Node.js 24, and a native Rust toolchain with edition 2024 support. Windows native builds also need the MSVC C++ build tools. Linux needs a graphical desktop and Electron's system libraries to run the app.

From the repository root:

```sh
bun run setup          # install app dependencies from app/bun.lock
bun run build:native   # build the helper and CLI for this machine
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

`pack` and `dist` build only for the current platform and architecture. They disable signing identity discovery, Windows signing, notarization, and publishing. macOS builds use ad-hoc signing by default; set `SIMPLEMD_SIGN_IDENTITY` to opt into local Developer ID signing. They can download Electron and packaging tools. They do not install the app or create a release.

See the [app guide](app/README.md) for controls, platform limits, packaging, and validation. Windows and Linux runtime behavior still needs verification on those operating systems. Cross-platform source code and CI configuration do not establish that the installed app works there.

## Command line

```sh
simplemd file.md
simplemd file.md:42
simplemd 'file.md#heading'
printf '# Draft\n' | simplemd --stdin-name draft.md -
simplemd --wait file.md
simplemd export file.md --format html -o out.html
simplemd export file.md --format pdf -o out.pdf
export EDITOR='simplemd --wait'
```

On macOS, choose SimpleMD > Install Command Line Tool. Windows installation adds the CLI to your user PATH; DEB packages install it on PATH. Saving keeps `--wait` running until the tab closes or a discard completes. Existing export outputs require `--force`. See [the CLI guide](docs/cli.md) for every command, exit codes, URL opens and Git editor setup.

## File-manager previews

macOS previews use the Quick Look preview and thumbnail extensions described in [the integration spec](docs/specs/quick-look.md). The app has no Finder keyboard hook and requests no Accessibility or Automation permission. Quick Look packaging and fixture qualification are separate from the app cleanup.

Windows includes an Explorer preview pane handler, toggled with Alt+P. It needs WebView2 for formatted previews and falls back to source when unavailable. Explorer MDX previews differ from the app and Mac Quick Look; see [Windows preview limits](docs/specs/windows-preview.md#user-visible-limits).

On Windows and Linux, open notes through File > Open, Open With, file associations, or an explicit command-line file path. The old preview-only global shortcut is removed. The app stays resident in the tray for warm opens; Launch at Login is optional. See [Linux integration](app/integrations/linux/README.md).

## Releases and updates

Installers will appear on [GitHub Releases](https://github.com/JonathanRReed/Simple-md/releases) when a release is published. macOS releases require Developer ID signing and notarization. Windows releases require SignPath signing unless the owner explicitly enables unsigned output. Homebrew and winget publication are separate owner steps. See the [Code signing policy](docs/release.md#code-signing-policy).

For an unsigned Windows installer, verify its SHA-256 against the release checksums. If SmartScreen blocks it, choose More info, then Run anyway after confirming the source. If that option is unavailable, follow your organization's policy.

Packaged releases with update metadata check for stable updates at most daily and download in the background. Disable them in Settings or with `auto-update = false`. Use Check for Updates in the SimpleMD menu on macOS or Help on Windows/Linux. Restart to Install Update asks for confirmation and settles unsaved edits. Unsigned Mac, development and local packages without `app-update.yml` skip updates; DEB installations use the package manager. Check for Updates reports check failures. Restart to Install Update reports when no update is ready; normal quit never installs an update.

See the [owner release runbook](docs/release.md) for local macOS signing, Actions builds, and winget/Homebrew manifest generation.

## License

[MIT](LICENSE). Copyright 2026 Jonathan Ray Reed. The license also ships in packaged app resources.

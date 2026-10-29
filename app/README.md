# SimpleMD app

This directory contains the Electron app. Bun bundles the TypeScript code; Rust provides the native file-manager helper.

## Read and edit

Open a Markdown file through File > Open, a file association, or the command line. Switch between live preview, split view, and source editing in the View menu or command palette. Live preview switches to source editing above 250,000 characters.

The renderer supports Shiki code highlighting, KaTeX math, Mermaid-compatible diagrams through Pele, task lists, footnotes, GitHub alerts, and frontmatter. Raw HTML is escaped. MDX is read-only, and JSX components never execute.

Preferences opens from the toolbar, app menu, or Command/Control+,. It controls appearance, editing defaults, text size, autosave, Vim, spellcheck, preview integration, login behavior, and the global shortcut. Changes apply immediately and persist. Invalid shortcut changes leave the previous binding in place.

The app includes find, outline navigation, Vim mode, spellcheck, table editing, theme and reading-width settings, PDF export, HTML export, and printing. Saved notes can keep pasted images in an adjacent `assets/` directory. Local Markdown links open in the app, with back and forward navigation.

Autosave is a setting. Check it before editing a file you want to keep unchanged. Clicking task checkboxes edits the note. External file changes require Reload or Keep mine when they conflict with local edits.

Use Command on macOS and Control on Windows and Linux for the common shortcuts:

- Open: Command/Control+O
- Save: Command/Control+S
- Read or edit: Command/Control+Enter
- Command palette: Command/Control+Shift+P
- Find: Command/Control+F
- Outline: Command/Control+Shift+O
- Editing modes: Command/Control+Alt+1, 2, or 3

## File-manager integration

The app must be running for helper-driven previews. Launch at Login is optional and off by default. Closing the window can leave the app in the tray; Quit exits it.

On macOS, the Rust helper checks Finder's foreground state, text focus, and current Accessibility selection before claiming Space for Markdown. It resolves file URLs outside the key callback. This Space path needs Accessibility permission only. `.txt` stays outside the Markdown Space association. The tray menu controls Space previews and exposes permission guidance. Command+Shift+Space is a separate fallback that may request Automation access to Finder and System Events. Declining permissions still allows File > Open.

In the reading view, Space or Escape dismisses the window. Enter or `e` switches a Markdown note to editing. MDX remains read-only. The helper's `--probe` reports foreground app, text focus, Accessibility state, and selected paths for a separate native check.

On Windows, use File > Open, Open With, or the global shortcut. Bare-Space interception is unavailable.

Linux has no portable bare-Space backend or selected-file lookup. A registered global shortcut cannot discover the selected note there. Use File > Open, Open With, or pass an absolute file path. See the [Linux integration guide](integrations/linux/README.md) for desktop entries and AppImage setup. Tray and shortcut availability also depend on the desktop and session, including Wayland.

## Develop and check

Use Bun 1.4.3 or newer, Node.js 24, and native Rust with edition 2024 support. Use the MSVC Rust toolchain and C++ build tools on Windows. Use a glibc Linux build host for Linux artifacts. The host-checking scripts reject mismatched Bun and Rust architectures, musl targets, cross-compilation, and universal macOS packages.

Run these inside `app/`, or use the same commands through the root package scripts:

```sh
bun install --frozen-lockfile
bun run build:native
bun run start
bun run typecheck
bun run test
bun run test:packaging
bun run check:rust
bun run test:rust
```

`start` builds the JavaScript app and opens Electron. It does not build Rust. If your shell sets `ELECTRON_RUN_AS_NODE`, unset it before starting Electron. The helper is optional for ordinary editing. Development helper lookup uses `native/target/release/`; `build:native` copies the matching host binary there after building it under `native/target/<rust-host>/release/`.

The build emits `dist/main.mjs`, a compile-cache bootstrap that imports `main-app.mjs`. A persistent Node worker handles Markdown rendering. `dist/render-worker.mjs` and shared chunks ship with the app through the `dist/**/*` package glob. Bun bundles runtime dependencies, so they are development dependencies in `package.json`.

The source is divided into `src/main/`, `src/renderer/`, `src/shared/`, and `native/`. Main and renderer changes share a document-ID protocol for rendering, saves, disk-change acknowledgement, and document readiness. Keep that protocol aligned across the preload bridge.

After integrating and building the app, run the user-flow smoke script from this directory:

```sh
bun run build
bun scripts/verify-smoke.ts
```

The script uses temporary fixtures and an isolated `SMD_USER_DATA` profile. That development-only mode disables native hooks, global shortcuts, login changes, and OS recent-document writes. It requires a build containing the isolation contract. It retains results, logs, screenshots, and PDFs in the temporary directory reported by the script. PDF text assertions require `pdftotext`. It does not test installed file associations, permissions, or file-manager hooks.

For local performance investigation, `bun run bench` runs the benchmark script. Record the exact revision, host, cold or warm state, fixture, and measured completion marker before comparing results. A half Dock bounce remains a target to measure after integration. It has not been proved by this packaging work. This guide makes no latency, energy-use, or battery-life guarantee.

## Package locally

```sh
bun run pack:plan
bun run pack
bun run dist
```

Both packaging commands build JavaScript and the Rust helper first. The helper build uses an explicit host triple and target directory, so a foreign `CARGO_BUILD_TARGET` or `CARGO_TARGET_DIR` cannot select a different packaged helper. The package includes only the exact helper binary and the root MIT license as extra resources. Use these scripts instead of invoking electron-builder directly.

`pack` creates an unpacked app. `dist` uses the platform's configured targets:

| Build host | Targets |
| --- | --- |
| macOS | DMG and ZIP |
| Windows | NSIS installer |
| Linux | AppImage and DEB |

Output goes to `app/release/`. A build only targets the host's current architecture. Build separately on each OS and architecture you intend to support.

Local scripts set `CSC_IDENTITY_AUTO_DISCOVERY=false`, `mac.identity=null`, `mac.notarize=false`, `dmg.sign=false`, `win.signExecutable=false`, and `publish=never`. They discard inherited signing and publishing credentials before building. Windows resource metadata and icons remain enabled. The scripts can download build tools; they never request notarization or upload a release. `pack:plan` reads the Rust host and prints the unsigned configuration without compiling, packaging, or importing electron-builder.

These artifacts have no publisher signing or notarization from this project. Electron's upstream signatures can remain on shipped components. Unsigned macOS bundles, especially on arm64, still need direct launch and trust-policy checks. Windows SmartScreen and Linux sandbox or AppImage dependencies are separate runtime checks. This repository does not bypass those checks or select signing identities automatically.

`build/entitlements.mac.plist` gives the main app JIT support and Apple Events access for the fallback shortcut. `build/entitlements.mac.inherit.plist` gives Electron helpers JIT support without Automation access. Neither file adds unsigned executable memory or library-validation exceptions. These are inputs for a future reviewed signing workflow; the unsigned path does not apply them. Before signed distribution, inspect the main app, Electron helpers, and Rust helper signatures and entitlements in the exact package, then test permissions and preview behavior. Signing, notarization, Gatekeeper checks, and installed-app QA remain separate work.

## CI and remaining gates

After packaging, check the archived render worker under Electron from the repository root:

```sh
bun run test:asar /absolute/path/to/app.asar
```

This launches a temporary Electron harness with an isolated profile, without starting SimpleMD's native hooks or login integration. It checks that the bootstrap, main bundle, worker, and shared chunks match the current `dist`, remain packed, and render highlighted TypeScript and Python fences through the worker protocol. It retains the archive hash, runtime result, HTML, and logs in the reported temporary directory. This checks Electron's ASAR worker loader. It does not launch the packaged app's normal UI or establish trust, permissions, or installed behavior.

The [desktop workflow](../.github/workflows/desktop.yml) installs locked dependencies, runs TypeScript checks and Bun tests, checks Rust formatting, checks and tests Rust, then builds and packages unsigned artifacts. Its native runner matrix covers macOS arm64, macOS x64, Windows x64, and Linux x64. CI pins [Bun 1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3); macOS runner labels follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Artifacts remain workflow attachments for seven days. The workflow has read-only repository permissions and no release job. It does not exercise the graphical smoke script, run benchmarks, install packages, or validate permissions and file associations. Windows arm64 and Linux arm64 are accepted by the host-only script but are outside this CI matrix.

No Windows or Linux desktop runtime has been verified from this Mac. Treat window controls, tray behavior, file associations, local image loading, printing, and the Explorer global shortcut as external QA gates until they run on those systems. Packaging configuration and passing unit tests are separate evidence from an installed application.

## License

[MIT](../LICENSE). Copyright 2026 Jonathan Ray Reed.

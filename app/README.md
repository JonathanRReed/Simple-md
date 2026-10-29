# SimpleMD app

This directory contains the Electron app. Bun bundles the TypeScript code; Rust provides `simplemd-helper` for macOS save metadata.

## Read and edit

Open a Markdown file through File > Open, a file association, or the command line. Switch between Live, Side by side, and Source editing in the View menu or command palette. Live preview switches to source editing above 250,000 characters.

The renderer supports Shiki code highlighting, KaTeX math, Mermaid-compatible diagrams through Pele, task lists, footnotes, GitHub alerts, and frontmatter. Author HTML is sanitized. Markdown and MDX are editable. JSX components and expressions never execute.

Preferences opens from the toolbar, app menu, or Command/Control+,. It controls appearance, editing defaults, text size, autosave, Vim, spellcheck, and login behavior. Changes apply immediately and persist. Old preview and shortcut settings are ignored on load and removed on the next save.

The app includes find, outline navigation, Vim mode, spellcheck, table editing, theme and reading-width settings, PDF export, HTML export, and printing. Saved notes can keep pasted images in an adjacent `assets/` directory. Local Markdown links open in the app, with back and forward navigation.

Autosave is a setting. Check it before editing a file you want to keep unchanged. Clicking task checkboxes edits the note. External file changes require Reload or Keep mine when they conflict with local edits.

Saves preserve UTF-8 bytes, the BOM, existing line endings and the final newline. New line breaks use the original file's dominant ending, or LF on a tie. Invalid UTF-8 and files containing NUL bytes, including UTF-16, open read-only. Table navigation leaves spacing intact, and task toggles change only the checkbox marker.

A save atomically replaces the file. Other hard links keep the old content. Saving through a symbolic link replaces its target and keeps the link. On macOS, the Rust helper copies extended attributes, Finder tags and ACLs to the temporary file before replacement. The app restores permissions separately and does not copy BSD flags. The helper runs as one short-lived process per save, without file-manager hooks, with a five-second timeout. A metadata-copy failure logs an error and the save proceeds. Build the helper with `bun run build:native` to preserve metadata during development.

Locked or unwritable files open read-only. Document reads use a nonblocking file handle, require a regular file and stop at 64 MB. This leaves room above the 20 MB rendering gate while rejecting FIFOs, devices and directories.

Local resources and links stay within the detected Git or Astro public root, or the document folder when no root exists. A leading slash without a root resolves inside the document folder. HTML export embeds supported local images up to 25 MB each, after checking their real paths and file types. A missing, unsupported or refused image logs a warning and does not cancel export. Static exports drop local links and local srcset attributes to avoid exposing absolute paths or creating links that break when the export moves. Failed local image URLs are also removed from the exported HTML.

MDX edits in Live and Source modes parse ranges in the worker without rendering a preview. Side by side and Read render the document. Beyond 128 nested JSX elements, the preview shows escaped source with a "Nested MDX shown as source" marker. The source remains editable.

Use Command on macOS and Control on Windows and Linux for the common shortcuts:

- Open: Command/Control+O
- Save: Command/Control+S
- Read or edit: Command/Control+Enter
- Command palette: Command/Control+Shift+P
- Find: Command/Control+F
- Outline: Command/Control+Shift+O
- Editing modes: Command/Control+Alt+1, 2, or 3

## File-manager integration

The app stays resident in the tray for warm file opens. Launch at Login is optional and off by default. Closing a normal document window hides it after settling edits; Quit exits the app. Clicking the tray icon shows or hides the current window.

macOS file previews belong to the Quick Look preview and thumbnail extensions described in [the spec](../docs/specs/quick-look.md). Quick Look works independently of the running app. The Accessibility hook, Automation fallback, preview permission guidance, and preview-only global shortcut have been removed. Extension packaging and fixture qualification remain separate checks.

The reading view uses normal app activation and Dock visibility. Space and Escape do not dismiss it. Enter or `e` switches to editing.

On Windows and Linux, use File > Open, Open With, drag and drop, file associations, or an explicit command-line file path. The global shortcut was only for the removed selection preview, so it is removed on every platform. See the [Linux integration guide](integrations/linux/README.md) for desktop entries and AppImage setup. Tray availability depends on the desktop and session, including Wayland.

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

`start` builds the JavaScript app and opens Electron. It does not build Rust. If your shell sets `ELECTRON_RUN_AS_NODE`, unset it before starting Electron. The helper is optional for opening files. On macOS, saving an existing file uses it to preserve metadata when available. Development helper lookup uses `native/target/release/`; `build:native` copies the matching host binary there after building it under `native/target/<rust-host>/release/`.

The build emits `dist/main.mjs`, a compile-cache bootstrap that imports `main-app.mjs`. A persistent Node worker handles Markdown rendering. `dist/render-worker.mjs` and shared chunks ship with the app through the `dist/**/*` package glob. The browser render-core bundle is built only by its Node-free core test and is excluded from packaging. Bun bundles runtime dependencies, so they are development dependencies in `package.json`.

The source is divided into `src/main/`, `src/renderer/`, `src/shared/`, and `native/`. Main and renderer changes share a document-ID protocol for rendering, saves, disk-change acknowledgement, and document readiness. Keep that protocol aligned across the preload bridge.

After integrating and building the app, run the user-flow smoke script from this directory:

```sh
bun run build
bun scripts/verify-smoke.ts
```

The script uses temporary fixtures and an isolated `SMD_USER_DATA` profile. That development-only mode disables login changes and OS recent-document writes. It requires a build containing the isolation contract. It retains results, logs, screenshots, and PDFs in the temporary directory reported by the script. PDF text assertions require `pdftotext`. It does not test installed file associations or Quick Look extensions. The `bytes-` cases exercise exact editor and saved bytes, read-only encodings, paste, undo/redo, tables, tasks and macOS metadata. They require the native helper on macOS. To check local blog files without changing them, set `SMD_BYTE_BLOG_DIR` to their directory and run `bun scripts/verify-smoke.ts bytes-blog-`. The script saves temporary copies and compares both copies and originals with the original bytes.

For local performance investigation, `bun run bench` runs the benchmark script. Record the exact revision, host, cold or warm state, fixture, and measured completion marker before comparing results. A half Dock bounce remains a target to measure after integration. It has not been proved by this packaging work. This guide makes no latency, energy-use, or battery-life guarantee.

## Performance gates

Run `bun run perf:gate` from the repository root or this directory. It builds the app, generates deterministic fixtures, builds the measurement helper, and opens isolated Electron profiles. It prints the JSON receipt path last. Keep the Mac plugged in and avoid typing in the test windows. The full run opens many documents and can take several minutes.

The receipt contains every sample, marker, cache state, assertion failure, fixture digest, build hash, and host detail. Gates use the targets in `docs/PLAN.md`. A failed gate exits nonzero; tabs and two document panes report `n/a` until they exist. `bun run bench.ts --perf-gate --smoke` runs a reduced local GUI check without enforcing absolute thresholds. Hosted macOS CI compiles that entrypoint and runs its protocol, fixture, and statistics tests because the runner has no stable logged-in GUI session.

Memory uses five settled samples of every PID from `app.getAppMetrics()`. The separate `perf-memory` binary in the existing Rust package reads macOS `proc_pid_rusage` physical footprint and resident size. On Windows it counts private resident pages with `QueryWorkingSet` and records total resident pages beside them. It does not run the save-metadata helper, `footprint`, or `vmmap`. Values use decimal MB. RSS is diagnostic, not the gate.

Typing uses Event Timing for trusted `keydown` and `beforeinput` events in a 100k-character document. The receipt keeps p50, p95, p99, raw entries, trusted event counts, and the separate beforeinput-to-rAF lower bound. The API omits durations below 16 ms and rounds reported durations to 8 ms. Censored quantiles report bounds; missing API support cannot pass a gate. Each case verifies the complete editor text and saved bytes after typing, burst input, selection movement, backspace, undo, paste, and CDP composition. Composition still needs native IME qualification.

The opening benchmarks and read-mode smoke cases now use `read` instead of the removed `peek` intent. They retain the same read rendering, streaming, cache states, and completion markers. The app now shows a normal Dock icon for reads, so cold launch and hidden-window opens include normal app activation. They do not measure Quick Look.

First-readable is a separate double-rAF marker after mount. It does not await diagrams or font readiness. The existing `documentReady` marker keeps its meaning. The current worker highlights before sending its payload, so that cost remains in first-readable measurements. Process-cold tests do not purge the OS file cache. The receipt identifies the development bundle and records ASAR as absent; it does not qualify a packaged installation.

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

`build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist` give the main app and Electron helpers JIT support. Neither grants Apple Events access. Neither file adds unsigned executable memory or library-validation exceptions. These are inputs for a future reviewed signing workflow; the unsigned path does not apply them. Before signed distribution, inspect the main app, Electron helpers, and Rust helper signatures and entitlements in the exact package, then test saves and Quick Look behavior. Signing, notarization, Gatekeeper checks, and installed-app QA remain separate work.

## CI and remaining gates

After packaging, check the archived render worker under Electron from the repository root:

```sh
bun run test:asar /absolute/path/to/app.asar
```

This launches a temporary Electron harness with an isolated profile, without starting SimpleMD's login integration. It checks that the bootstrap, main bundle, worker, and shared chunks match the current `dist`, remain packed, and render highlighted TypeScript and Python fences through the worker protocol. It retains the archive hash, runtime result, HTML, and logs in the reported temporary directory. This checks Electron's ASAR worker loader. It does not launch the packaged app's normal UI or establish trust, permissions, or installed behavior.

The [desktop workflow](../.github/workflows/desktop.yml) installs locked dependencies, runs TypeScript checks and Bun tests, checks Rust formatting, checks and tests Rust, then builds and packages unsigned artifacts. Its native runner matrix covers macOS arm64, macOS x64, Windows x64, and Linux x64. CI pins [Bun 1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3); macOS runner labels follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Artifacts remain workflow attachments for seven days. The workflow has read-only repository permissions and no release job. It does not exercise the graphical smoke script, run benchmarks, install packages, or validate permissions and file associations. Windows arm64 and Linux arm64 are accepted by the host-only script but are outside this CI matrix.

No Windows or Linux desktop runtime has been verified from this Mac. Treat window controls, tray behavior, file associations, local image loading, and printing as external QA gates until they run on those systems. Packaging configuration and passing unit tests are separate evidence from an installed application.

## License

[MIT](../LICENSE). Copyright 2026 Jonathan Ray Reed.

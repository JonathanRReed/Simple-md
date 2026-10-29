# SimpleMD v1.0 plan

Decided on 2026-10-28 and revised the same day after an Opus 5.5 plan review. This file is the working contract for v1.0. Implementer and reviewer briefs link to it and to the specs in `docs/specs/`. Change it only when the owner changes a decision.

## Vision

SimpleMD is to Markdown what Ghostty is to terminals: very fast, native-feeling, configurable down to the details, and good enough by default that nobody needs to configure it. It is the small, powerful `.md` and `.mdx` reader and editor that belongs on every machine the owner uses.

## Audience

1. Developers and AI-heavy users who live in READMEs, `AGENTS.md`, `CLAUDE.md`, plan files and changelogs.
2. Anyone who double-clicks a `.md` file and currently gets a code editor or a plain text view.
3. The owner, writing single-file Astro MDX blog posts (`Personal-Site/src/content/blog`).

It is not a note-taking app, a writing workspace or a vault.

## Principles

- **Protect the file.** Saves keep the source byte-for-byte. Only explicit, undoable commands change bytes.
- **Speed is a feature with gates.** Every target below is a floor. Hill-climb below it.
- **Native where it is cheap, light everywhere.** Use the OS for menus, context menus, dialogs, share, accent color and recents. Draw only what Electron cannot give us natively without a heavy cost.
- **File-first.** One file is the unit. Sibling files are reachable by link. There is no file tree.
- **Nothing executes.** MDX, raw HTML and code blocks are displayed, never run.

## Platforms

Mac first, then Windows. Both ship in v1.0. macOS 13 Ventura or later, with separate Apple Silicon and Intel downloads (confirm Electron 45's minimum when packaging). Linux builds stay in CI and get runtime qualification after v1.0. The stack stays Electron plus Rust. Platform-specific native pieces (the macOS Quick Look extension in Swift, the Windows preview handler in Rust) live beside it.

## Decisions

### Files and editing

| Area | Decision |
| --- | --- |
| Byte preservation | Lines the user did not touch keep their exact bytes, including CRLF, mixed endings, BOM and the final newline. New line breaks use the file's dominant ending, or LF on a tie. Files that are not valid UTF-8 (UTF-8 with BOM is fine) open read-only with a notice. Safe saves keep extended attributes and Finder tags by copying them to the temporary file before the atomic rename. Document hard-link behavior. |
| Editing | CodeMirror 6 live preview, Obsidian-style: syntax hides away from the cursor, and images, math and tables render inline. No WYSIWYG document model. |
| Modes | Live, Source, and Side by side (formerly "Split"). "Split" now means two panes. |
| MDX | Same editor as `.md`. ESM and JSX are highlighted from parser ranges mapped through edits, and are never hidden or rewritten. Use parse-only `micromark-extension-mdxjs` to find MDX ranges. Never use `@mdx-js/mdx` compile or evaluate, and do not write a custom Lezer MDX grammar. The preview renders the Markdown. Lowercase HTML goes through the sanitizer. Capitalized components render as labeled boxes with their children rendered. Expressions render as inert labeled tokens. `<style>` and `<script>` never apply. While MDX is incomplete or invalid, typing, saving and undo keep working, and the preview keeps the last good render and shows the failing range as escaped source. |
| Astro | Root-relative paths such as `/images/x.png` resolve against the nearest `public/` folder through the shared URL resolver. No schema validation. |
| Source ranges | Rendered blocks carry source ranges from markdown-it `token.map`. MDX ranges, block identities, scroll sync and change highlights all reuse them. |

### Rendering

| Area | Decision |
| --- | --- |
| Reference | The github.com repository file page, not the REST API. |
| Sanitizer | `docs/specs/sanitizer.md`. One `sanitizeAuthorHtml()` in a DOM context, before every HTML insertion. No DOM library in the worker. |
| GitHub features | Heading slugs matching `github-slugger`, emoji shortcodes, every GitHub math syntax, Mermaid through Pele, alerts, footnotes, task lists, reference-style images, `<picture>` and `#gh-dark-mode-only` / `#gh-light-mode-only` following the app theme, GFM `www.` autolinks and single `~` strikethrough. `typographer` off. Do not add mermaid.js or MathJax. |
| Not supported | GeoJSON, TopoJSON and STL fences render as code. Custom image emoji such as `:octocat:` render as text. |
| Remote images | Load by default. Config `remote-images = true | false`. |
| Render core | From milestone 1 on, the parser, sanitizer policy and HTML generation have no Node or Electron imports, so one browser bundle can serve Quick Look and WebView2. |

### Window and UI

| Area | Decision |
| --- | --- |
| Tabs | Drawn by the app inside one window and one renderer, styled to feel native. Planning allowance is 5 to 25 MB per extra open document (inconclusive probe; measure in the real app), versus about 60 to 120 MB for an Electron native tab. Same on all platforms. No tear-off, no cross-window dragging, no session restore. "Move Tab to New Window" exists as a command only. |
| Splits | Up to 2 panes, side by side or stacked. A document appears in at most one pane, because Side by side mode already covers source plus preview. Nested split trees are 1.x. |
| Opening files | New files open as a tab in the frontmost window. Config `open-in = tab | window`. Opening an already-open file focuses its tab. A plain click on a sibling link navigates in place with back and forward. Command/Control-click opens a new tab. |
| Closing | Command/Control-W closes the tab. Closing the last tab closes the window. On macOS the app stays resident in the tray. |
| Native items | Settings in its own window. Modes in the View menu plus a small toggle. Native context menus with spelling and link actions. System accent drives chrome, selection and focus. Native Share on macOS only. Dock menu and Windows Jump List with recents. Mac find pasteboard. No motion after the text is readable. AppKit-native Settings and toolbar are 1.x, and only if the HTML versions feel wrong. |
| Reading look | Editorial theme by default, with a one-click GitHub style toggle. Both use one semantic renderer. |
| Themes | About 8 curated token files that style the document area only, with separate light and dark choices that follow the system. Shiki themes match. |
| Typography | Separate reading, writing and code fonts. Family, size, line height and content width. No custom CSS. |
| Config | Ghostty-style `key = value` lines at `~/.config/simplemd/config` (platform equivalent on Windows). One schema drives the parser, validation, the Settings window and the docs. Synced both ways with Settings, with live reload. Unknown keys are reported, never silently dropped. No TOML library. |

### Workflow features

| Area | Decision |
| --- | --- |
| CLI and URL scheme | `docs/specs/cli-ipc.md`. Rust binary forwarding over a private socket or pipe. URL scheme supports `open` only. |
| Change highlights | One feature: block highlights against a baseline text. The baseline is either the last-seen version (watch mode, when another tool rewrites an open file) or `git show HEAD:<path>` run with an argument array (git view). No git library. Baselines live in memory only and are cleared by Mark Seen. Highlights are static, with no animation, and never steal focus or scroll. |
| Raycast and Alfred | Documented script commands that call the CLI or URL scheme. No extension packages. |
| Drag-out export | Drag from the window to get a PDF or HTML file, created before the drag starts. |
| Hashing | "Native hashing" means `node:crypto`, not Rust or N-API. |
| Memory | No native memory-pressure bridge. Byte-capped caches with one shared budget. |

### Platform integration

| Area | Decision |
| --- | --- |
| macOS preview | `docs/specs/quick-look.md`. A data-based Quick Look preview: the extension renders HTML with the shared render core in JavaScriptCore and Quick Look displays it. No WKWebView, no scripts, no network entitlement. Diagrams show as code blocks in Quick Look; pressing Enter opens the file in SimpleMD with full diagrams. Plus a thumbnail (Core Text) extension. Built with Command Line Tools only. Chosen after the M0 spike: about 39 ms to ready versus about 615 ms for WKWebView, with App Sandbox as the only entitlement. |
| Windows preview | `docs/specs/windows-preview.md`. Rust Explorer preview pane handler using WebView2, with a fallback if the spike fails. |
| Peek removal | The experimental Windows Space hook is deleted in milestone 0. The macOS Accessibility hook is deleted once Quick Look passes its fixture set. After both are gone, delete `peek.ts`, `peek-request.ts`, the `peek` intent and peek hide-on-close. The Rust side then ships only the CLI and the Windows handler. |
| Tray | The app stays resident by default on macOS so warm opens stay fast. |
| Rename | SimpleMD. Linux binary `simplemd`. Bundle ID stays `com.jonathanreed.simplemd`. On first launch, migrate only settings and recents from the old `Simple-md` folder; drop old caches. Document that the old `Simple-md.app` or old Windows install can be removed by hand. |
| Distribution | Free, open source, MIT. macOS: Developer ID signing and notarization with the `simplemd-notary` keychain profile. Windows: SignPath Foundation signing in GitHub Actions plus winget. GitHub Releases, then auto-update, then a personal Homebrew tap. |
| AI | None. Not in the app. |

## Performance gates

Full method: `docs/specs/perf-harness.md`.

| Gate | Target | Baseline on 2026-10-28 (contended host) |
| --- | --- | --- |
| Warm open to first readable, normal files | p95 < 150 ms | M3: 15 to 23 ms visible; 21 to 30 ms hidden in the tray after a one-second dwell (rapid hide and reopen still stalls about 500 ms in macOS window ordering; recorded as a diagnostic) |
| First screen readable, files up to 20 MB | p95 < 200 ms | M3: 21 to 32 ms up to 2 MB; 167 ms at 20 MB, all opens succeed |
| Cold launch to first readable | p95 < 800 ms | M3: 424 to 435 ms |
| Switch to an already-open 100k tab | p95 < 50 ms | not built yet |
| Typing in a 100k document, one and two panes | p95 editor latency minus a matched empty-textarea control is at most one display frame plus 8 ms, from at least 40 trusted keys per case, with Event Timing's unreported sub-16 ms events counted as under 16 ms | 18 of 18 calibrated cases pass with 0 or 8 ms excess; the raw 24 ms p95 is the same in an empty textarea, so it is injection and frame cost, not the editor |
| Memory, one document, settled | physical footprint summed over app processes < 200 MB (stretch goal 150 MB) | M3: 143 MB (M0: 159 MB) |

- Memory uses physical footprint, the same measure as Activity Monitor's Memory column. Windows uses private working set. Summed RSS is recorded beside it but is not the gate, because shared framework pages are counted many times. An empty Electron window measures 365 MB summed RSS.
- Absolute gates run locally on the owner's MacBook through `bun run perf:gate`, and the JSON receipt is attached to each PR. Hosted CI only catches relative regressions.
- Until the end of milestone 3, a PR must not regress any gate. From then on, gates block merges. The owner confirmed the 200 MB target after M0 measured 159 MB, with 150 MB as a stretch goal for M3.

## Do not build

Every implementer and reviewer brief includes this list.

- No vault, file tree, backlinks, graph, tag database or crawler.
- No AI chat, completion, rewriting, embeddings or agent features.
- No WYSIWYG document model or whole-document normalization.
- No executing MDX, raw HTML, embedded apps or code.
- No proprietary table format or spreadsheet engine.
- No formatting ribbon, minimap, stats dashboard or goal gamification.
- No git staging, commits, branches or history browser.
- No cloud uploads, CMS credentials, social publishing or bundled browser.
- No automatic curly quotes, rewrapping, list renumbering or table formatting on save.
- No theme marketplace, plugin runtime or custom CSS.
- No focus stealing, automatic scroll-to-edit or network link cards.
- No PDF book production, citation management or TeX installation.
- No tab tear-off, session restore, nested splits, Raycast or Alfred extension packages, git libraries, TOML libraries, DOM libraries in the worker, mermaid.js or MathJax.

## Milestones

Each milestone is one branch and one PR to `main`, except where it is split below. A PR merges after its acceptance checks pass in the running app and its perf receipt is attached.

0. **Foundations.**
   - Commit this plan, `ROADMAP.md` and `docs/specs/`.
   - Rename to SimpleMD with settings migration.
   - Build the perf-gate harness and measure the real app's memory.
   - Build the 41-document GitHub file-page corpus as commit-pinned snapshots with an attribution file and a refresh script.
   - Delete the Windows Space hook.
   - Run the Quick Look spike.
   - The owner applies to SignPath Foundation.
1. **Byte preservation, sanitizer and MDX editing.**
   - Byte-preservation rules and fixtures: LF, CRLF, mixed endings, BOM, astral characters, no final newline, invalid UTF-8, UTF-16, xattrs and Finder tags.
   - Sanitizer with hostile fixtures.
   - The shared URL resolver, including Astro `public/`.
   - Source ranges on blocks.
   - Render core free of Node.
   - MDX editing with an inert preview.
   - Acceptance: all 15 blog posts open, render correctly, and save unchanged. Security review required.
   - **After merge:** publish an unsigned 0.x prerelease on GitHub Releases.
2. **GitHub fidelity.**
   - Heading slugs, emoji, math syntaxes, `<picture>` and theme fragments, reference images and footnotes, cross-file fragments, autolinks and strikethrough. `typographer` off.
   - Acceptance: the corpus passes, meaning zero unexplained semantic DOM mismatches after the named normalizations. Math and diagrams are compared by source and successful render, not layout. Declared exceptions are allowed.
   - **By the end of M2:** CI builds the Windows preview spike for the owner to run.
3. **Document model and speed.**
   - Start with DocumentSession extraction and no UI changes: distinct `DocumentId`, `PaneId`, `RevisionId` and `RequestId` types, IPC authority from the sender, and stale replies rejected per document revision.
   - Then: `node:crypto` hashing, incremental block identities and live decorations, first screen first, readable text before highlighting, viewport-triggered diagrams, fine-grained Shiki, removal of the Side by side double render, and one shared cache budget.
   - Gates become blocking at the end of M3.
4. **Quick Look** (moved up). Data-based preview and thumbnail extensions, then deletion of the Accessibility hook and the macOS peek path. Security review required.
5. **Native-feeling window**, as three PRs:
   - 5a: tabs and panes.
   - 5b: Settings window, context menus, share, accent, recents and find pasteboard.
   - 5c: themes, reading toggle, typography and config file.
6. **Developer workflow.** Rust CLI and URL scheme, change highlights (watch mode and git HEAD), Raycast and Alfred scripts, drag-out export. Security review required.
7. **Windows.** Preview pane handler (or the fallback), Jump List, and removal of the remaining peek code. The owner verifies on Windows hardware.
8. **Release.**
   - macOS notarization.
   - The Windows release built in GitHub Actions with SignPath.
   - GitHub Release, auto-update, winget and the Homebrew tap.
   - If SignPath declined, the owner chooses between a paid signing service and unsigned builds with documented SmartScreen steps.
9. **Linux qualification** (after v1.0).

## v1.0 bar

The spirit: worth shipping, not immediately beaten by an alternative, and genuinely useful. It feels like Ghostty: faster than every rival we measure to open and type in, native-feeling on Mac and Windows, deeply configurable, with defaults good enough that nobody needs to change them.

The hard gate:

- Every performance gate passes on the owner's MacBook.
- The fidelity corpus passes against github.com file pages.
- Every blog post opens, edits and saves byte-for-byte.
- Quick Look works on a clean Mac with no permissions granted.
- The owner has checked the Windows install and preview (or its fallback) on Windows hardware.
- Mac builds are signed and notarized. Windows builds are signed, or the owner has chosen the documented fallback.
- Head-to-head speed measurements against QLMarkdown, Typora, Obsidian and the VS Code preview are recorded with one screen-capture method on three fixtures. The owner judges them, along with editing and reading on real blog posts. Fidelity is measured against github.com only.

## Workflow

- The orchestrator writes each milestone's brief and acceptance checks, linking this plan, the relevant spec, and the do-not-build list.
- GPT-6.1 Sol (high) through Codex implements each milestone in its own worktree and branch.
- The orchestrator verifies in the running app against the gates and corpus.
- Opus 5.5 reviews at batch boundaries, briefed to look for over-complication and do-not-build violations. The sanitizer, Quick Look, and the CLI and URL scheme each get a focused security review regardless of timing.

## Owner steps

- Milestone 0: apply to SignPath Foundation for open-source Windows signing.
- Milestone 0: rename the GitHub repository to SimpleMD.
- After milestone 1: approve publishing the unsigned 0.x prerelease.
- End of milestone 2: run the Windows preview spike on Windows hardware.
- Milestone 7: verify Windows behavior on Windows hardware, and Linux later.
- Milestone 8: store notarization credentials with `xcrun notarytool store-credentials simplemd-notary`, using an Apple ID app-specific password and team `AJ9VWBRNZN`.

## Research

The six research reports and the plan review from 2026-10-28 are kept locally in `.audit/research/` (git-ignored). The parts implementers need are in `docs/specs/`.

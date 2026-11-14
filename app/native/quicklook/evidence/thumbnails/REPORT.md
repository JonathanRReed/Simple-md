# Markdown thumbnail routing

November 14, 2026. macOS 27.2, Apple Silicon. Source base `6353cd54856818e46692fc265cc1380899cbf941` on `daily-driver`.

The installed SimpleMD 0.1.0 thumbnail extension drew `.md` and `.mdx` title cards
before any test registration. macOS does not categorically prohibit custom
thumbnails for Markdown or for types conforming to plain text.

This verifies a configuration with SimpleMD elected and resolved as the opener.
FluxMarkdown was already in Trash and absent from PlugInKit. These conditions
were observed, not changed by this investigation. Their necessity is unproven.
Visible Finder icons and active FluxMarkdown coexistence were not tested.

## Supported declarations

Apple's [thumbnail extension guide](https://developer.apple.com/documentation/quicklookthumbnailing/providing-thumbnails-of-your-custom-file-types)
requires exact UTIs and documents the minimum dimension. It does not document a
priority key that makes a third-party extension always win. Keep the existing
four exact supported types, the public thumbnail extension point, the
Objective-C-visible principal class and minimum dimension 32. Keep MDX's
`public.plain-text` conformance. No native rendering or type change was needed.

The packaging verifier now checks the extension point, principal class and
minimum dimension, with rejection tests. It continues checking exact types.
Package declaration checks do not prove provider selection.

## Background requests

All server requests used new fixtures with `qlmanage -t -x -s 256 -o` and bounded
per-file unified-log intervals. No generator or content type was forced.

| Experiment | Result |
| --- | --- |
| Baseline `.md`, resolved as `net.daringfireball.markdown` | Installed SimpleMD selected and drew its card. |
| Baseline `.mdx`, resolved as `com.jonathanreed.simplemd.mdx` | Installed SimpleMD selected and drew its card. |
| Same CLI without `-x` | PNGs, but no attributable provider draw. The Markdown output showed raw source. |
| Separately identified, signed test extension also eligible for Markdown/MDX | Installed SimpleMD remained selected for both. |
| Unique test types conforming to plain text, UTF-8 plain text and data | Test extension drew all three. TextEdit remained the opener for the text controls. |
| Fresh `.md` and `.mdx` after cleanup | Installed SimpleMD selected and drew again. |
| Fresh `.txt` after cleanup | Apple's text provider selected; no SimpleMD draw. |

The baseline Markdown daemon record at 17:09:10.127 names bundle ID
`com.jonathanreed.simplemd.thumbnail` from the installed app. Its provider logs:

```text
2026-11-14 17:09:10.329 Df SimpleMDQLThumbnail[77107:566383b] [com.jonathanreed.simplemd.quicklook:thumbnail] Thumbnail drawn file=<private> elapsed_ms=38.020458
```

The baseline MDX daemon record at 17:09:21.781 names the same installed extension:

```text
2026-11-14 17:09:21.819 Df SimpleMDQLThumbnail[77107:566383e] [com.jonathanreed.simplemd.quicklook:thumbnail] Thumbnail drawn file=<private> elapsed_ms=4.405083
```

The PNGs show the title cards. A PNG alone is not provider attribution.

## Built-in provider and other apps

`/System/Library/ExtensionKit/Extensions/TextThumbnailExtension.appex` has ID
`com.apple.quicklook.thumbnail.TextExtension`. Its secure system extension point
lists `public.plain-text`, RTF, RTFD, property lists, XML, JSON and OpenDocument
text. It lists neither Markdown nor MDX explicitly. Third-party code keeps the
public `com.apple.quicklook.thumbnail` point.

Current source for [QLMarkdown](https://github.com/sbarex/QLMarkdown),
[Syntax Highlight](https://github.com/sbarex/SourceCodeSyntaxHighlight) and
[Glance](https://github.com/samuelmeuli/glance) provides preview extensions, not a
modern thumbnail counterexample. [PreviewMarkdown](https://github.com/smittytone/PreviewMarkdown)
and [PreviewCode](https://github.com/smittytone/PreviewCode) ship ordinary
thumbnail extensions with exact UTIs and minimum dimension 32. PreviewMarkdown
imports Markdown as plain text and warns about UTI conflicts with other editors.
The local FluxMarkdown bundle has a preview extension only.

The [framework overview](https://developer.apple.com/documentation/quicklookthumbnailing)
and [WWDC19 session 719](https://developer.apple.com/videos/play/wwdc2019/719/)
explain built-in support and custom providers. The reviewed sources supply no
complete modern provider ordering. The [forum question about overriding built-ins](https://developer.apple.com/forums/thread/757302)
has no answer, so it is not an Apple engineer's ruling.

The earlier own-MDX success and later Apple-text routing remain historical facts.
This run reproduces own-MDX success and adds ordinary Markdown success. It does
not isolate why the older configuration failed or establish that removing
FluxMarkdown is a necessary or sufficient fix.

## Cleanup and proof limits

The test host and extension used IDs beneath `com.jonathanreed.simplemd.thumbtest`.
Neither host app nor Electron was launched. The clone was unregistered with
`pluginkit -r` and `lsregister -u`, then deleted with its new sandbox container.
It left no PlugInKit record, Launch Services path or running test process.
Standalone build extensions were also removed.

Relevant PlugInKit entries, saved handler preferences and resolved handlers/types
match before and after. FluxMarkdown stayed absent from PlugInKit and in Trash.
No installed-app election, opener or app bundle was changed. No cache reset ran.

Both production extensions built with `nice -n 15` and verified universal
signatures. Their declarations passed the new verifier. These fresh build checks
are separate from the installed-app runtime receipts. No new full app was packaged
or installed; no Finder UI or clean-machine check ran.

Typecheck and lint pass. Packaging tests pass with 28 tests and one optional
exact-package test skipped. The fresh worktree needed a release CLI build for
the existing binary scan; that CLI was never executed. Lint used the already
installed Bun canary after the Homebrew Bun recursed into the package script.

The full local report, source snapshots, PNGs, per-file logs and before/after
snapshots are retained outside git under `.audit/daily-driver/thumbnails.md` and
`.audit/daily-driver/scratch-thumbnails/receipts/` in the owner's primary checkout.

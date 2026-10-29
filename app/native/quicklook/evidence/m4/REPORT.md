# M4b packaged Quick Look report

Tested on 2026-10-29 in branch t3/1101377a, only in
/Users/jonathanreed/.t3/worktrees/Simple-md/t3-1101377a.

Implementation and packaging are committed. The full Quick Look acceptance gate
does not pass. All eight supported fixtures use SimpleMD's escaped-source preview.
MDX uses SimpleMD's thumbnail extension, but seven Markdown fixtures use Apple's
Text thumbnail extension. The rich static renderer remains an integration
dependency. This report does not qualify milestone 4.

## Design

The production bundle IDs are com.jonathanreed.simplemd.preview and
com.jonathanreed.simplemd.thumbnail.

The data-based QLPreviewProvider reads at most 4,194,304 bytes. It creates one
JavaScriptCore context per process on a serial render queue, evaluates the bundled
trusted render-core.js, and calls the synchronous global
renderStaticHtml(source, filePath, options). Documents enter as arguments,
never as evaluated JavaScript. Options carry appearance, truncation, and
invalid-UTF-8 flags. The reply is complete UTF-8 HTML with scripts and external
resources denied by CSP.

preview/render-stub.ts is the permitted integration stub. It escapes source
inside a pre element, shows truncation and encoding notices, and creates no
resource or link elements. It does not render Markdown, math, or images.
Local image access and placeholders, Shiki, KaTeX, and sanitizer parity must be
verified when the shared static entry replaces it. Mermaid remains code in
Quick Look.

The thumbnail provider uses the spike's Core Text card and reads at most
65,536 bytes. Both extensions have App Sandbox as their sole entitlement.
Neither has a network entitlement. JavaScriptCore has no fetch, DOM, Node,
or native file bridge. This is source and entitlement evidence, not a packet
capture of macOS host activity.

Both plists list net.daringfireball.markdown, public.markdown,
com.jonathanreed.simplemd.mdx, and com.fluxmarkdown.mdx. They do not list plain
text. The host exports the SimpleMD MDX type and imports FluxMarkdown's MDX
type for coexistence. The README documents the System Settings Quick Look
selection path. No Accessibility-path or app/native/src file changed.

## Packaging and signing

The pack command builds Electron and the existing host Rust helper.
The afterPack hook compiles both extensions with Command Line Tools, swiftc -O,
and a macOS 13 target for arm64 and x86_64. Lipo creates universal executables.
The preview JavaScript lives in the preview extension's Resources directory.

The hook signs each extension with hardened runtime and extension-only
entitlements before copying it into Contents/PlugIns. Developer ID signing uses
a secure timestamp. Electron-builder then signs the enclosing app with the same
identity and skips PlugIns, preserving the extension entitlements. The afterSign
hook runs codesign --verify --deep --strict --verbose=2 and checks both extensions'
IDs, content types, architectures, Mach-O deployment targets, identities,
timestamps, and exact sandbox-only entitlements.

Ad-hoc and Developer ID packaging passed. The signed run used
Developer ID Application: Jonathan Reed (AJ9VWBRNZN).
[Ad-hoc build](pack-adhoc.txt), [signed build](pack-developer-id.txt),
[installed signatures](run-3/signatures.txt),
[final package checks](packaging-final.txt).

Signed product code is unchanged from implementation commit c1d627e.
Later commits change the test runner and documentation.
[Source hashes](source-sha256.txt), [unchanged-source check](source-unchanged.txt),
[artifact hashes](artifact-sha256.txt).

The SDK emits its known missing-x86_64-slice warnings for
libswiftCompatibilityPacks.a. Both final slices and 13.0 targets verify.
Intel and macOS 13 execution remain untested. No Xcode or system software was
installed. Nothing was notarized.

## Packaged fixture results

The final run copied the unmodified signed package to
~/Applications/SimpleMD-M4-1101377a.app. Both plugins were registered and selected.
FluxMarkdown was temporarily ignored. The main app was closed throughout this
run. Each filename below links to its panel-only screenshot.

Reply time is launch through the provider's logged HTML-ready event.
Provider time starts at providePreview, before the file read.
Both exclude final host paint. The first request includes cold host startup.
Each row is one observation, not a performance gate or comparison.

| Fixture and panel | Preview attribution | Thumbnail attribution | Launch to reply, ms | Provider, ms | Visible result |
| --- | --- | --- | ---: | ---: | --- |
| [README.md](run-3/panels/README.md.png) | SimpleMD stub, pass | System, failed attribution | 2731.6 | 6.73 | Readable escaped source. |
| [math.md](run-3/panels/math.md.png) | SimpleMD stub, pass | System, failed attribution | 275.7 | 1.84 | Literal math source. KaTeX pending. |
| [mermaid.md](run-3/panels/mermaid.md.png) | SimpleMD stub, pass | System, failed attribution | 307.2 | 2.15 | Literal fence and diagram source. |
| [local-image.md](run-3/panels/local-image.md.png) | SimpleMD stub, pass | System, failed attribution | 263.9 | 1.69 | Literal image syntax. No image loaded. |
| [fixture.mdx](run-3/panels/fixture.mdx.png) | SimpleMD stub, pass | SimpleMD, pass | 262.5 | 1.64 | Inert JSX and import. Thumbnail omits frontmatter and import. |
| [large.md](run-3/panels/large.md.png) | SimpleMD stub, pass | System, failed attribution | 294.6 | 37.71 | 4,194,304 preview bytes. Truncation note visible. |
| [empty.md](run-3/panels/empty.md.png) | SimpleMD stub, pass | System, failed attribution | 297.6 | 1.84 | Empty preview. No decoding failure. |
| [non-utf8.md](run-3/panels/non-utf8.md.png) | SimpleMD stub, pass | System, failed attribution | 281.8 | 1.70 | Replacement glyphs and encoding note. |
| [not-markdown.txt](run-3/panels/not-markdown.txt.png) | System, expected | System, expected | n/a | n/a | System text preview. Neither SimpleMD provider claims it. |

[Raw timings](run-3/timings.json), [runtime attribution](run-3/runtime.txt),
[fixture hashes and byte counts](run-3/fixture-sha256.json),
[main-app-closed receipt](run-3/main-app-closed.txt).

Captures occurred 4.16 to 4.23 seconds after launch because the runner deliberately
waits four seconds before capture. This is a capture bound, not measured first
paint. The host had 14 logical CPUs and load averages 8.79, 17.80, and 18.77
at the start. No speedup claim is made.

The 512-pixel thumbnails are under [thumbnails](run-3/thumbnails).
The MDX card is SimpleMD's title card. The Markdown images are system text
thumbnails, so successful CLI exits do not pass provider attribution.
All final panels and the MDX card were inspected. The focused denial query
contains no matching extension denial during the final full run.
[Query result](run-3/sandbox-denials.txt).

Supplemental packaged MDX checks isolate the thumbnail reader from the Markdown
routing failure. large.mdx read exactly 65,536 bytes, empty.mdx read zero,
and non-utf8.mdx drew readable replacement glyphs. All three have matching
SimpleMD draw logs and inspected images.
[Logs](diagnostic-thumbnail-caps/runtime.txt),
[large card](diagnostic-thumbnail-caps/large.mdx.png),
[empty card](diagnostic-thumbnail-caps/empty.mdx.png),
[invalid-byte card](diagnostic-thumbnail-caps/non-utf8.mdx.png).
These checks do not close the Markdown attribution gate.

## Unresolved Markdown thumbnail selection

Three full runs reproduce the same attribution failure. Runs 1 and 2 retain
their failed assertions. The final runner records every fixture before failing.
The failure is seven missing Markdown thumbnail receipts and the missing
Markdown large-file runtime cap receipt.
[Final failed check](e2e-run-3.txt).

Focused checks rejected these explanations without changing production code:

| Condition tested | Result |
| --- | --- |
| Request thumbnails before previews | Same Markdown attribution failure |
| Force either declared Markdown UTI in qlmanage | System thumbnail |
| Add the spike's Markdown import to a temporary host and re-sign | System thumbnail |
| Launch the packaged host once, terminate it, then request thumbnails | System thumbnail |
| Leave FluxMarkdown at its default election | System thumbnail |
| Reset the generator with qlmanage -r | System thumbnail |
| Use the public QLThumbnailGenerator API | System thumbnail |
| Give only the temporary host a unique ID and re-sign | System thumbnail |

The thumbnail-agent log identifies
com.apple.quicklook.thumbnail.TextExtension for Markdown and
com.jonathanreed.simplemd.thumbnail for MDX.
[Routing log](thumbnail-routing-import.txt).
Foundation and the metadata index resolve Markdown to the declared
net.daringfireball.markdown type.
[Foundation result](resolved-types.txt),
[type declarations](markdown-type-declarations.txt).

Apple requires exact supported UTI matches for thumbnail extensions.
The package declares the resolved type, so a missing parent-UTI declaration
does not explain these observations.
[Apple documentation](https://developer.apple.com/documentation/quicklookthumbnailing/providing-thumbnails-of-your-custom-file-types).

The cause of the provider choice is not isolated. No system thumbnail provider
was disabled, broader type claimed, or entitlement widened. The next
qualification step is to reproduce provider selection on a clean macOS account
or machine and compare registered metadata against the working spike.
Rich-renderer integration needs its own fixture rerun and security review before
merge.

## Checks

| Check | Result | Receipt |
| --- | --- | --- |
| bun run build:native | Pass | [Log](build-native.txt) |
| bun run typecheck | Pass | [Log](typecheck.txt) |
| bun run test | 247 pass, 1 artifact-dependent skip, 0 fail | [Log](test.txt) |
| bun run test:packaging | 17 pass, 1 artifact-dependent skip, 0 fail | [Log](test-packaging.txt) |
| Packaging tests with SIMPLEMD_PACKAGED_APP | 18 pass, 0 fail for both signing modes | [Ad-hoc](packaging-adhoc.txt), [final signed](packaging-final.txt) |
| bun run build | Pass | [Log](build.txt) |
| bun run pack, ad-hoc | Pass | [Log](pack-adhoc.txt) |
| SIMPLEMD_SIGN_IDENTITY=... bun run pack | Pass | [Log](pack-developer-id.txt) |
| Packaged JavaScriptCore behavior | Pass, empty, invalid UTF-8, exact cap, truncation, escaping, appearance, repeated render | [Log](preview-developer-id.txt) |
| Native thumbnail reader and layout | Pass | [Log](thumbnail-check.txt) |
| Packaged fixture gate | Fail, Markdown thumbnail attribution | [Log](e2e-run-3.txt) |
| Supplemental packaged MDX thumbnail cap and encoding | Pass | [Log](diagnostic-thumbnail-caps.txt) |
| Final cleanup audit | Pass | [Receipt](cleanup-final.json) |

No full perf:gate, push, pull request, or notarization ran.

## Registration and cleanup

There were 11 temporary host registrations: three full fixture runs and eight
focused diagnostics. Every run used only
/Users/jonathanreed/Applications/SimpleMD-M4-1101377a.app.

Ten copies kept the host ID com.jonathanreed.simplemd. The host-ID diagnostic
used com.jonathanreed.simplemd.m4diagnostic in its temporary copy only.
Every copy contained the two production extension IDs:

- com.jonathanreed.simplemd.preview, at
  Contents/PlugIns/SimpleMDQLPreview.appex.
- com.jonathanreed.simplemd.thumbnail, at
  Contents/PlugIns/SimpleMDQLThumbnail.appex.

Each EXIT trap restored FluxMarkdown and both SimpleMD elections to default,
removed both plugins with pluginkit -r, unregistered the temporary host with
lsregister -u, and attempted to unregister the build-copy path.
The unregistered build-copy path returned -10814. Only processes executing
that run's exact copy were terminated. The installed copy, each named
/tmp/simplemd-m4-test.* helper directory, and these new containers were deleted:

- ~/Library/Containers/com.jonathanreed.simplemd.preview
- ~/Library/Containers/com.jonathanreed.simplemd.thumbnail

Native build scripts also remove their temporary extension and compiler
directories. qlmanage -r cache ran after each cleanup and in the final audit.
Raw cleanup logs list every concrete scratch path.
[Final full-run cleanup](run-3/cleanup.txt),
[supplemental cleanup](diagnostic-thumbnail-caps/cleanup.txt).

All 11 before/after FluxMarkdown snapshots match exactly. Its final election is
default. The final audit finds no test plugin, LaunchServices entry, installed
copy, extension container, process, or helper directory.
[Audit](cleanup-final.json), [FluxMarkdown](flux-final.txt),
[preview](preview-final.txt), [thumbnail](thumbnail-final.txt),
[LaunchServices](launchservices-final.txt), [processes](processes-final.txt).

The signed product remains at app/release/mac-arm64/SimpleMD.app,
unregistered, for review. Generated large-file fixtures and redundant first-run
image copies remain local and are excluded from git; the runner recreates them.
No other worktree was edited.

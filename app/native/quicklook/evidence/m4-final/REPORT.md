# M4 static renderer qualification

Tested on October 29, 2026, in branch `t3/41c64cc3`, only inside
`/Users/jonathanreed/.t3/worktrees/Simple-md/t3-41c64cc3`.
The packaged source is commit `f4cabca01e0f143c5b5334b1bf045636d9420c63`.
Later commits contain evidence and this report.

The real preview passes the full fixture set in both signing modes with SimpleMD
closed. Custom thumbnail routing does not pass. Apple supplies every final
Markdown and MDX thumbnail on this host. Milestone 4 remains unqualified.

The resumed `e8b84c3` and `c9ae325` commits were reviewed and checkpointed in
`f9ab7f7`. Qualification exposed a real cold-MDX failure. Bun's browser condition
selected an entity decoder that calls `document.createElement`. The debug parser
also required `console`. The extension now bundles with `NODE_ENV=production`,
`--conditions worker`, and `--production`. The new cold-MDX test runs the actual
IIFE in bare JavaScriptCore. Swift also preserves the rejected promise's error.
[Original failure](mdx-diagnostic.txt), [passing test](mdx-fix-test-final.txt),
[source hashes](source-final.json), [unchanged source receipt](source-unchanged.txt).

The integration uses `QLPreviewProvider` and an HTML `QLPreviewReply`. The preview
extension's Resources contain the shared `renderStaticHtml` IIFE. A static Swift
renderer evaluates it once per process on a serial queue. Author text and file
paths enter as arguments. JavaScriptCore has no DOM, Node, fetch, or native file
bridge. The static sanitizer enforces the shared author policy before display.
Mermaid stays escaped code. MDX imports and expressions never execute.

The source reader caps input at 4,194,304 bytes and passes truncation and invalid
UTF-8 flags to the renderer. Both notices appear in the panels. The HTML has no
page script and uses this CSP:

```
default-src 'none'; style-src 'unsafe-inline'; img-src data: file:; font-src data:
```

Both extensions have only `com.apple.security.app-sandbox`. No entitlement was
added. Remote images become placeholders before Quick Look displays the page.
The bare-context tests, sanitizer suite, exact entitlements, and CSP establish
that rendering blocks automatic author remote-resource loads. This is not a packet capture of
all macOS host activity. Appearance follows system CSS and uses no app settings.

Page sizes use the same fixed `/project/` path on both sides. These are complete
UTF-8 HTML documents, measured from the packaged bundle in JavaScriptCore.
KaTeX CSS and its 20 embedded WOFF2 fonts appear only when generated math exists.
Author-supplied `katex` classes cannot enable those assets.

| Fixture | Source bytes | Before HTML bytes | After HTML bytes | After fonts |
| --- | ---: | ---: | ---: | ---: |
| README | 2,905 | 382,425 | 13,705 | 0 |
| Math | 36 | 377,900 | 378,074 | 20 |
| MDX | 116 | 375,724 | 7,004 | 0 |

The math page grows by 174 bytes for the notice and placeholder styles. README
falls by 96.4 percent and MDX by 98.1 percent. Installed README replies are 14,260
bytes for ad-hoc and 14,265 bytes for Developer ID. Five relative links resolve to
the longer fixture path, adding 555 and 560 bytes respectively.
[Before](baseline-sizes.json), [after with hashes](final-sizes-packaged.json),
[measurement inputs](measure-sizes.ts), [page-size chart](page-sizes.html).

Local images use the existing sandbox grant. Swift reads at most 32 raster
candidates, 2 MB each and 8 MB total. ImageIO accepts PNG, JPEG, GIF, and WebP with
at most 8,192 pixels per dimension and 16,777,216 pixels per image. The host embeds
readable files as data URLs. Missing, denied, remote, or unsupported images become
escaped alt-text placeholders. Picture sources cannot replace the host's result.

Both runs logged one requested sibling and zero embedded images for
`local-image.md`. A separate fixture inside the preview extension's own container
logged two candidates and one embedded image. Its red square renders beside a
missing-sibling placeholder. This tests available sandbox access without adding
an entitlement or requesting a grant.
[Ad-hoc logs](run-adhoc-final/runtime.txt),
[signed logs](run-developer-id/runtime.txt).

The thumbnail investigation compared the M0 host at `52a936a` with the prior and
current packages. The change imports Markdown using the same declaration as M0.
It does not make SimpleMD the owner of Markdown or claim generic text.

| Declaration | M0 host | Prior package | Current package |
| --- | --- | --- | --- |
| Markdown ownership | Imported `net.daringfireball.markdown` | No Markdown declaration | Same import as M0 |
| Markdown tags | md, markdown, mdown, mkd; text/markdown | None | Same as M0 |
| MDX ownership | Exports `com.jonathanreed.simplemd.qlspike.mdx` | Exports `com.jonathanreed.simplemd.mdx`; imports `com.fluxmarkdown.mdx` | Same as prior package |
| UTI conformance | `public.plain-text` | `public.plain-text` for MDX | `public.plain-text` for Markdown and MDX |
| Host document types | None | Editor, Alternate rank, Markdown and MDX `LSItemContentTypes` | Same as prior package |
| Thumbnail supported types | Two Markdown IDs, spike MDX ID, Flux MDX ID | Two Markdown IDs, product MDX ID, Flux MDX ID | Same as prior package |

Both thumbnail plists declare `net.daringfireball.markdown`, `public.markdown`,
and the two relevant MDX identifiers. Neither claims `public.plain-text` or `.txt`.
Foundation resolves `.md` to `net.daringfireball.markdown` and `.mdx` to
`com.fluxmarkdown.mdx`, both supported by the package.
[Exact comparison](uti-comparison.json), [resolved types](routing-reset/types.txt),
[packaged declarations](packaged-types.json).

The historical M0 host was rebuilt with its exact source and plists and Developer
ID signing. Its former README thumbnail win did not reproduce. Apple supplied
both replay thumbnails. The first resumed package run did produce a SimpleMD MDX
thumbnail, before the MDX preview fix. Both final package runs selected Apple's
`com.apple.quicklook.thumbnail.TextExtension` for MDX too. Registration logs show
SimpleMD's thumbnail election as `use`. `qlmanage -r` plus a cache reset did not
change the choice. The cause of this change is not isolated; the replay alone
does not establish causation.
[Historical replay](spike-replay/runtime.txt),
[first MDX draw](run-adhoc/runtime-recovered.txt),
[reset diagnostic](routing-reset/runtime-cleanup.txt).

No system provider was disabled, broader UTI claimed, or entitlement widened.
The declaration mismatch is repaired, but provider selection remains unresolved.
A clean account or machine is still needed to separate this host's provider state
from package behavior. Successful qlmanage PNG creation is not SimpleMD thumbnail
proof. The final runner records Markdown routing separately and fails explicitly
for the missing MDX draw; all custom thumbnail cases remain failed in this report.

Timing starts immediately before spawning `qlmanage -p` and ends at the provider's
`Preview ready` log. It does not measure first paint. Each final CLI preview used
a fresh extension process, so each paid bundle initialization once. The original
stub took 260 to 307 ms for later small requests and 2,732 ms for the first README.
Its provider work was about 2 ms, so most of that original interval preceded the
provider. It was not a 7 ms rich-render measurement.

| Path | First README reply, ms | Later small replies, median and range, ms | Small provider work, median and range, ms |
| --- | ---: | ---: | ---: |
| Prior escaped-source stub | 2,731.6 | See prior per-fixture table, about 260 to 307 | About 2 |
| Final ad-hoc rich preview | 2,773.8 | 428.8, 397.7 to 461.9 | 109.5, 103.1 to 124.9 |
| Final Developer ID rich preview | 2,781.4 | 408.2, 389.3 to 432.7 | 100.9, 94.4 to 111.2 |

The small-request summary excludes the first README, large file, and `.txt`, and
uses eight requests per signing mode. The signed run's median breakdown is:

| Stage | Median, ms | Observed range, ms |
| --- | ---: | ---: |
| Spawn through provider entry | 305.1 | 288.9 to 322.5 |
| Render queue | 0.057 | 0.048 to 0.074 |
| Document read | 0.102 | 0.088 to 0.134 |
| JavaScriptCore context | 1.079 | 0.993 to 1.123 |
| Bundle read | 4.458 | 4.302 to 5.418 |
| Bundle evaluation | 84.349 | 81.664 to 89.660 |
| Markdown, sanitizer, and generated content | 7.131 | 2.926 to 17.226 |
| Image assembly | 0.113 | 0.080 to 7.985 |

The first signed README spent 2,639 ms before provider entry and 142 ms inside it.
The large fixture took 5,781 ms inside the ad-hoc provider and 4,461 ms inside the
signed provider. Almost all of that was rich rendering of the capped 4 MB text.
The improved runner waits for a panel, then allows five seconds for display to
settle. Its capture bounds are not first-paint measurements. The earlier fixed
four-second capture missed the large panel and captured a blank cold README.
Those failed receipts remain under `run-adhoc`.

Controlled changes remove unused Shiki themes, minify the IIFE, omit math assets
from non-math replies, and skip image parsing when no image exists. Bundle size
fell from 11,655,565 to 9,707,887 bytes. The preserved five alternating before/after
JSC pairs measured median bundle evaluation at 119.21 versus 117.57 ms, with
ranges 116.06 to 127.98 and 111.45 to 131.79 ms. Warm render medians were 16.56
versus 16.38 ms, with overlapping ranges. That comparison is inconclusive for
speed. Its earlier after bundle was 9,705,211 bytes; the final MDX dependency fix
adds 2,676 bytes. The final rich previews take longer than the escaped-source previews. They
render different content, so this comparison cannot measure a speedup from the
asset changes.

The ad-hoc full run began at load averages 8.70, 11.20, 12.34; the signed run at
4.84, 9.02, 11.15, on 14 logical CPUs. These runs were sequential, not an
interleaved signing comparison. Host load prevents attributing their difference
to signing. Full `perf:gate` was excluded.
[Prior stub report](../m4/REPORT.md), [interleaved micro measurements](jsc-interleaved.json),
[ad-hoc breakdown](timing-breakdown-adhoc.json),
[signed breakdown](timing-breakdown-developer-id.json).

Both final runs exercised installed copies of the packaged app with no SimpleMD
main process before or after the sequence. All 22 panel-only screenshots were
inspected. Each supported file has a SimpleMD preview receipt. Every thumbnail in
the final runs came from the system; `.txt` used the system preview too. The
hostile page preserves only the fixture's safe text. The following links open
the actual captured panels. Reply times are launch-to-reply milliseconds.

| Fixture | Ad-hoc panel and reply ms | Developer ID panel and reply ms | Visible result |
| --- | --- | --- | --- |
| README.md | [2773.8 ms](run-adhoc-final/panels/README.md.png) | [2781.4 ms](run-developer-id/panels/README.md.png) | Readable Markdown and links. |
| math.md | [435.8 ms](run-adhoc-final/panels/math.md.png) | [407.3 ms](run-developer-id/panels/math.md.png) | Inline and display math with KaTeX fonts. |
| mermaid.md | [397.7 ms](run-adhoc-final/panels/mermaid.md.png) | [390.0 ms](run-developer-id/panels/mermaid.md.png) | Escaped diagram source in a code block. |
| local-image.md | [432.1 ms](run-adhoc-final/panels/local-image.md.png) | [415.3 ms](run-developer-id/panels/local-image.md.png) | Denied sibling and remote image placeholders. |
| fixture.mdx | [461.9 ms](run-adhoc-final/panels/fixture.mdx.png) | [432.7 ms](run-developer-id/panels/fixture.mdx.png) | Labeled Widget box and escaped expression. Import hidden. |
| large.md | [6091.6 ms](run-adhoc-final/panels/large.md.png) | [4783.5 ms](run-developer-id/panels/large.md.png) | 4,194,304 bytes read. Truncation notice visible. |
| empty.md | [460.6 ms](run-adhoc-final/panels/empty.md.png) | [409.1 ms](run-developer-id/panels/empty.md.png) | Empty page without an error. |
| non-utf8.md | [425.5 ms](run-adhoc-final/panels/non-utf8.md.png) | [389.5 ms](run-developer-id/panels/non-utf8.md.png) | Replacement glyphs and encoding notice. |
| hostile.md | [416.3 ms](run-adhoc-final/panels/hostile.md.png) | [389.3 ms](run-developer-id/panels/hostile.md.png) | Only Safe remains below the heading. No active HTML. |
| readable-image.md | [414.2 ms](run-adhoc-final/panels/readable-image.md.png) | [420.0 ms](run-developer-id/panels/readable-image.md.png) | Red square rendered. Missing sibling placeholder. |
| not-markdown.txt | [System](run-adhoc-final/panels/not-markdown.txt.png) | [System](run-developer-id/panels/not-markdown.txt.png) | System preview. Neither SimpleMD extension claims it. |

[Ad-hoc attribution and stages](run-adhoc-final/runtime.txt),
[signed attribution and stages](run-developer-id/runtime.txt),
[ad-hoc fixture hashes](run-adhoc-final/fixture-sha256.json),
[signed fixture hashes](run-developer-id/fixture-sha256.json),
[ad-hoc main-app check](run-adhoc-final/main-app-closed.txt),
[signed main-app check](run-developer-id/main-app-closed.txt).

Packaging used Command Line Tools, universal extension executables, and macOS 13
load-command targets. Each extension was signed before the enclosing app.
Ad-hoc signatures use no timestamp. Developer ID uses
`Developer ID Application: Jonathan Reed (AJ9VWBRNZN)`, hardened runtime, and
secure timestamps. Both installed packages pass recursive strict signature and
sandbox-only entitlement verification. The signed and ad-hoc `app.asar` and
`render-core.js` hashes match exactly. Intel and macOS 13 execution are untested.
The SDK's missing-x86_64 compatibility-pack warnings remain in the build logs.
[Ad-hoc artifact](artifact-adhoc.json), [signed artifact](artifact-developer-id.json),
[ad-hoc installed signatures](run-adhoc-final/signatures.txt),
[signed installed signatures](run-developer-id/signatures.txt).

| Check | Result | Receipt |
| --- | --- | --- |
| `bun run build:native`, first resumed check | Pass | [Log](build-native-resume.txt) |
| `bun run typecheck` after MDX fix | Pass | [Log](typecheck-mdx.txt) |
| `bun run test` | 246 pass, 1 package-dependent skip, 0 fail | [Log](test-final.txt) |
| `bun run test:corpus` | 2 pass, 0 fail | [Log](test-corpus-final.txt) |
| `bun run test:packaging` | 17 pass, 1 package-dependent skip, 0 fail | [Log](test-packaging-final.txt) |
| Packaging with `SIMPLEMD_PACKAGED_APP`, ad-hoc | 18 pass, 0 fail | [Log](packaging-adhoc-final.txt) |
| Packaging with `SIMPLEMD_PACKAGED_APP`, Developer ID | 18 pass, 0 fail | [Log](packaging-developer-id.txt) |
| `bun run build` | Pass | [Log](build-final.txt) |
| `bun run pack`, ad-hoc | Pass | [Log](pack-adhoc-final.txt) |
| `SIMPLEMD_SIGN_IDENTITY=... bun run pack` | Pass | [Log](pack-developer-id.txt) |
| Native real-renderer check, ad-hoc | Pass | [Log](preview-adhoc-final.txt) |
| Native real-renderer check, Developer ID | Pass | [Log](preview-developer-id.txt) |
| Packaged previews and `.txt` exclusion, both modes | Pass, all panels inspected | Fixture table above |
| Full fixture command, ad-hoc | Failed, missing MDX thumbnail attribution; Markdown also uses Apple | [Log](e2e-adhoc-final.txt) |
| Full fixture command, Developer ID | Failed, missing MDX thumbnail attribution; Markdown also uses Apple | [Log](e2e-developer-id.txt) |
| Final cleanup | Pass | [Audit](cleanup-final.json) |

Cleanup covered five temporary host registrations after resume. Four used
`~/Applications/SimpleMD-M4-final.app`; the historical replay used
`~/Applications/SimpleMD-M4-SpikeReplay.app`. The package runner ignored only
FluxMarkdown's preview election during its checks. Every EXIT trap restored it
with `pluginkit -e default -i com.xykong.Markdown.QuickLook` and compared its
before/after snapshots. All five pairs match, and the final election is default.
The replay left FluxMarkdown at default throughout.

For each product copy, the trap restored both SimpleMD elections to default,
removed the two appex registrations with `pluginkit -r`, terminated only extension
processes executing that exact temporary copy, and ran `lsregister -u` for the
installed and build paths. Build-path unregistration returned `-10814` because
that copy was not registered. The replay removed its thumbnail registration and
unregistered its host in the same way. The traps deleted both temporary hosts,
four `/tmp/simplemd-m4-test.*` directories, the replay scratch directory, the
product preview and thumbnail containers, and the replay host and thumbnail
containers. Each trap ran `qlmanage -r cache`.

The final audit cleared the cache again, checked all product and spike extension
IDs, checked the product host and extension containers, checked both temporary
host paths and every recorded scratch path, searched LaunchServices for the
installed and build paths, and checked for app and extension processes. All were
absent. Three generated 4,750,044-byte large fixtures were deleted after recording
their hashes and panels. The runner recreates them. The signed release product
remains under this worktree at `app/release/mac-arm64/SimpleMD.app`, unregistered.

[Initial interrupted-run cleanup](run-adhoc/cleanup.txt),
[final ad-hoc cleanup](run-adhoc-final/cleanup.txt),
[signed cleanup](run-developer-id/cleanup.txt),
[reset diagnostic cleanup](routing-reset/cleanup.txt),
[replay cleanup](spike-replay/cleanup.txt),
[exact final path audit](cleanup-final.json), [FluxMarkdown](flux-final.txt),
[LaunchServices](launchservices-final.txt), [processes](processes-final.txt),
[generated fixture deletion](generated-fixture-cleanup.json).
The two final traps retain exit status 1 from thumbnail qualification. That is
not a cleanup failure; the independent audit passes.

No Xcode or system software was installed. No notarization, full performance
gate, push, or pull request ran. No other worktree was edited. Independent
security review, clean-machine thumbnail routing, physical Finder Space-key
acceptance, Intel execution, and notarized distribution remain outside this
qualification. The unresolved thumbnail routing prevents milestone 4 acceptance.
The structured [verification receipt](RECEIPT.md) records this as a failed required
layer and passes [receipt validation](receipt-validation.txt).

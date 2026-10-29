# M4 security fixes and qualification

October 29, 2026. Worktree `t3/30c82650`, based on `m4-quicklook` at
`b8127efc9107ee13ead19d4b860329f0f5f99261`. Implementation and checks cover
`6a16d385198740e73cece2cc03dc7612ff8220ce`. The following checkpoint adds this
report and four screenshots only.

All six security findings are fixed. Packaged previews pass. Thumbnail routing
remains unqualified: macOS still selects Apple's text thumbnail extension for
both Markdown and MDX after removing the imported MDX declaration.

## Findings and regression tests

| Finding | Fix | Regression evidence |
| --- | --- | --- |
| HIGH: local file links | Preview assembly removes local navigation from Markdown and author anchors, longdesc, cite, action, itemtype and usemap. Fragments, HTTP, HTTPS and mailto remain. The ordinary renderer retains its existing link behavior. | `test/quicklook-security.test.ts` failed against the baseline file href and now passes for both preview entry points. |
| MEDIUM: duplicate IDs and unbounded rendering | Both ID allocators keep a next-suffix map per base and preserve collision output. Each native request owns a fresh JavaScriptCore context on a concurrent queue. Its execution watchdog has a 1.5-second deadline. Timeout or exception returns escaped source and a notice. | The 20,000-ID baseline failed the deadline assertion. A separate baseline browser run also exceeded that budget. The current static and DOM paths pass with identical IDs. Existing fixture, corpus, policy matrix and fuzz parity checks pass. Swift tests stop infinite bundle and promise loops, catch JS exceptions, verify escaped source and then render a rich document successfully. The baseline bundle loop required external termination. |
| LOW: deep nesting | An iterative pass flattens nesting beyond 512, retaining sanitized elements and text. JavaScript and Swift preview entry points fall back to escaped source on rendering errors. | The baseline 6,000-level fixture threw RangeError. It now preserves its text with at most 512 element levels. A deliberately invalid render path verifies the JavaScript fallback. Native tests verify exception fallback. |
| LOW: CSP and media | The CSP is `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`. Preview output removes video and source resource attributes. The spec pins this CSP. | The baseline CSP test failed. Exact CSP, media-attribute and embedded-image tests now pass. |
| LOW: skipped signing verification | `local-pack.mjs` calls final-app verification after the builder returns, independently of afterSign. Extensions use the explicit full `SIMPLEMD_SIGN_IDENTITY`, or ad-hoc signing when absent. | Baseline regression tests failed. The build wrapper now verifies when afterSign is never called and propagates verification errors. Both real package runs pass recursive signature, identity, timestamp, architecture, deployment target and entitlement checks. |
| LOW: theme logos, UTF-8 and privacy | App-owned theme markers survive image embedding. Truncation backs off an incomplete UTF-8 suffix. Preview and thumbnail filenames and error descriptions are private in logs. | The baseline theme-marker and public-log checks failed. Browser computed styles now show exactly one logo in each appearance. Native tests cover every split of 2-, 3- and 4-byte characters at the read limit. The baseline split reported invalid UTF-8; the fixed test passes. Packaged logs redact filenames. |

The preview shares one sanitized tree between image discovery and embedding.
Author HTML is not reparsed for those two operations. JavaScript receives no
native file callbacks. Native raster byte and pixel limits remain in force.

## Repository cleanup

Every deleted file was copied and byte-checked before deletion. The archive
manifest records each path, byte count and SHA-256:

`/Users/jonathanreed/Downloads/Simple-md/.audit/receipts/m4/evidence-archive/security-cleanup-manifest.json`

| Removed files | Count | Bytes |
| --- | ---: | ---: |
| Raw evidence, including scripts and executable fixtures | 796 | 8,337,419 |
| Spike source, plists, entitlements, build scripts and fixtures | 18 | 28,034 |

The removed spike files include PreviewController.swift, the duplicate top-level
PreviewProvider.swift, ParserRenderer.swift, Host.swift, both spike plists,
build.sh, preview.entitlements with network.client, host and data-preview
entitlements, StaticFixture.html, parser-entry.ts, the old thumbnail entitlement
and spike qualification script, and four unused spike fixtures.

SPIKE.md now describes the retained production build and archive. The two prior
final REPORT.md files remain. Their raw receipt paths are preserved inside the
archive with their repository-relative paths. This directory adds four panels,
560,221 bytes total. No executable file remains under evidence.

The manual qualification script, Python driver and window helper live in
`scripts/`. The shell header identifies the manual qualification purpose. Its
FluxMarkdown step runs only when that plugin is installed. The host no longer
imports `com.fluxmarkdown.mdx`; SimpleMD still exports its own MDX type and both
extensions retain the supported content-type list.

## Thumbnail retest

Both packages contain the UTI cleanup. Each test registered only a temporary copy
at `~/Applications/SimpleMD-M4-security.app`, selected SimpleMD's extensions,
temporarily ignored FluxMarkdown and cleared the thumbnail cache.

`qlmanage -r cache`, followed by `qlmanage -t -s 512` for README.md and fixture.mdx,
produced PNGs. That local command path did not log an attributable extension
render. It is not proof of SimpleMD thumbnail support.

A second pass with `qlmanage -t -x -s 512` produced both PNGs. Separate unified-log
intervals identify `com.apple.quicklook.thumbnail.TextExtension` for each file.
Neither interval contains a SimpleMD thumbnail draw. Removing the imported MDX
declaration did not resolve routing on this Mac. No generator or content type was
forced. The server routing receipts are in `thumbnail-retest/` below.

## Preview re-check

The ad-hoc packaged app passed all eleven panel requests with the main app closed:
README, math, Mermaid code, a denied local image, inert MDX, hostile HTML, a file
larger than 4 MB, empty input, invalid UTF-8, a sandbox-readable local image and
plain text. Each Markdown or MDX request logged SimpleMD's preview reply. The
`.txt` request did not reach SimpleMD. The readable-image request logged two
candidates and one embedded raster. Denied and remote images showed placeholders.
Large input can return the bounded source fallback.

I inspected the four retained panels: [README](README.md.png), [math](math.md.png),
[local-image fallback](local-image.md.png) and [inert MDX](fixture.mdx.png). README
text, KaTeX and inert MDX rendered correctly. The sibling-image panel showed the
expected sandbox placeholder. These are qlmanage panels, not a new Finder Space
or clean-machine qualification.

## Cleanup log

Both qualification scripts exited 0 through their cleanup traps. Each trap:

1. Restored FluxMarkdown with `pluginkit -e default -i com.xykong.Markdown.QuickLook`.
2. Restored the SimpleMD elections, removed both extensions with `pluginkit -r`
   and terminated any process from the temporary extension paths.
3. Ran `lsregister -u` for the installed copy and source package.
4. Deleted the temporary app, that run's scratch helper directory and both
   `~/Library/Containers/com.jonathanreed.simplemd.preview` and `.thumbnail`.
5. Ran `qlmanage -r cache`, compared FluxMarkdown's full before/after snapshots
   and required no SimpleMD PlugInKit matches or installed-copy registration.

The final independent audit repeated the FluxMarkdown default election and cache
reset. Both containers, the temporary app, its processes and LaunchServices
records for both app paths were absent. Standalone test extensions, the slow test
bundle and compiled probes were deleted. `lsregister -u` returned -10814 for the
unregistered source package; the subsequent dump confirmed no record remained.
The signed build output stays in `app/release/mac-arm64/SimpleMD.app`.

## Checks and proof limits

| Check | Result |
| --- | --- |
| `bun run build:native`, first check and final recheck | Pass |
| `bun run typecheck` | Pass |
| `bun run test` with signed SIMPLEMD_PACKAGED_APP | 256 pass, no skips or failures |
| `bun run test:corpus` | 2 pass; 41-document corpus gate passes |
| `bun run test:packaging` with each final package | 20 pass in each signing mode |
| `bun run build` | Pass |
| `bun run pack`, ad-hoc | Pass, including unconditional final verification |
| `bun run pack`, Developer ID Application: Jonathan Reed (AJ9VWBRNZN) | Pass, including unconditional final verification |
| Native JavaScriptCore regression checks | Pass, including watchdog, exceptions, recovery and UTF-8 boundaries |
| `git diff --check`, shell syntax and Python compilation | Pass |

Only Command Line Tools were used. No Xcode or system software was installed.
No notarization, full perf gate, push or PR occurred. Universal extensions passed
architecture and macOS 13 deployment-target checks; Intel and macOS 13 execution
were not tested. The CLT linker emitted its existing x86_64 compatibility-library
warning. Thumbnail routing remains unresolved.

Raw red/green tests, package logs, per-request runtime logs, fixture hashes,
cleanup logs and source probes are saved outside git at:

`/Users/jonathanreed/Downloads/Simple-md/.audit/receipts/m4/security-fixes/`

Branch t3/30c82650, head 6a16d385198740e73cece2cc03dc7612ff8220ce, checks passed; thumbnail routing remains unqualified.

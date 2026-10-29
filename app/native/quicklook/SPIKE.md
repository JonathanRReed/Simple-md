# Quick Look feasibility spike

Tested on 2026-10-28 in worktree `t3/b8791dd9`, starting at `a98679b`.
The tested Swift, plists, entitlements, and build script are in this directory.
The prior CLT compilation spike at `/tmp/simplemd-research/e-integration` supplied
the bundle layout and controller entry point. Its report was read without edits.

The spike fails milestone 0 acceptance. Registration works. The sandbox starts
the extension but logs denials, and WKWebView cannot launch its content process.
These results disprove this configuration on this Mac, not every possible
Quick Look implementation. No alternate renderer or broader entitlements were
tested after the failure.

## Acceptance results

| Check | Result | Direct evidence |
| --- | --- | --- |
| 1. Discover Developer ID-signed extension | Pass | After host registration and one launch, `pluginkit -m -A -D -vv -i com.jonathanreed.simplemd.qlspike.preview` lists the embedded extension. [Registration](evidence/registration-open.txt). |
| 2. Launch with no sandbox denials | Fail | PID 28379 gets `AppSandbox request successful`, then two `mach-lookup` denials. [Runtime](evidence/runtime-excerpt.txt). |
| 3. Render fixture in sandboxed WKWebView | Fail | `qlmanage -p` and Finder Space both call `preparePreviewOfFile` for `fixture.md`. WebKit fails before `didFinish`. Finder shows a generic file card. [Runtime](evidence/runtime-excerpt.txt), [Finder screenshot](evidence/finder-md.png). |
| Claim MDX after declaring its UTI | Fail | LaunchServices registers the spike MDX type as active, exported, and trusted. The fixture still resolves to `com.fluxmarkdown.mdx`, and Finder uses FluxMarkdown. [Declaration](evidence/mdx-declaration.txt), [types](evidence/types-registered.txt), [Finder tree](evidence/finder-mdx-ax.txt), [screenshot](evidence/finder-mdx.png). |
| Do not claim plain text | Pass | The fixture resolves to `public.plain-text`. Finder shows its standard text preview. Neither proxy nor Finder invokes the spike for `fixture.txt`. [Runtime](evidence/runtime-excerpt.txt), [Finder tree](evidence/finder-txt-ax.txt), [screenshot](evidence/finder-txt.png). |

The spike extension was temporarily selected with `pluginkit -e use`. No other
extension was disabled or given a different election. The MDX and text proxy
windows ran for six seconds each, then received SIGTERM. Their exit code was 0;
that exit code is not proof of successful rendering. The Markdown proxy also
returned 0 when closed despite its preview failure.

## Environment and build

- macOS 27.2, build `26B123`, arm64.
- Developer directory `/Library/Developer/CommandLineTools`. No full Xcode.
- Apple Swift 6.4, `swiftlang-6.4.0.34.1`.
- SDK `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`, recorded SDK version 27.0.
- Minimum deployment target 13.0 in both compiler targets and both plists.
- arm64 host and extension compiled, linked, signed, and launched locally.
- x86_64 host and extension compiled and linked into the universal bundles.
  Intel execution was not tested. The linker warned four times that
  `libswiftCompatibilityPacks.a` contains arm64 and arm64e but lacks x86_64.
  Linking still returned 0. [Build log](evidence/build.txt), [architectures](evidence/architectures.txt).

The exact fresh-shell build command, run from the repository root, was:

```sh
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /bin/bash --noprofile --norc app/native/quicklook/build.sh \
  'Developer ID Application: Jonathan Reed (AJ9VWBRNZN)' \
  /tmp/simplemd-qlspike-build-b8791dd9 \
  > /tmp/simplemd-qlspike-evidence-b8791dd9/build.txt 2>&1
```

It returned 0. The optional output directory must not exist. Omitting it creates
a new `/tmp/simplemd-qlspike.XXXXXX` directory. The script builds both architectures
with `swiftc`, combines them with `lipo`, signs inner code before outer code, and
runs recursive strict verification. It does not register or launch the app.

Both bundles use only `com.apple.security.app-sandbox = true`. There is no network
entitlement, application group, JIT entitlement, provisioning profile, or access
to Electron. The placeholder escapes the fixture text, disables page JavaScript,
uses a nonpersistent WKWebView data store, and sets `default-src 'none'`. It is not
the production Markdown renderer. Completion waits for navigation, an error,
or a ten-second timeout. Successful content readiness was not reached in this run.

Both signatures contain the Developer ID authority, team `AJ9VWBRNZN`, runtime
flag `0x10000`, and a secure timestamp. No keychain prompt blocked signing.
No notarization was attempted. [Extension signature](evidence/signing-preview.txt),
[host signature](evidence/signing-host.txt).

These checks ran against the installed throwaway copy before cleanup:

```sh
codesign --verify --deep --strict --verbose=2 \
  "$HOME/Applications/SimpleMDQLSpike.app"
spctl --assess --type execute --verbose=4 \
  "$HOME/Applications/SimpleMDQLSpike.app"
```

`codesign` returned 0 with `valid on disk` and `satisfies its Designated Requirement`.
[Verification](evidence/verify-installed.txt). `spctl` returned 3:

```text
/Users/jonathanreed/Applications/SimpleMDQLSpike.app: rejected
source=Unnotarized Developer ID
```

The local, non-quarantined app launched without a Gatekeeper override. This does
not prove that a downloaded release will launch.

## Registration and preview commands

The initial PlugInKit query returned `(no matches)`. The destination app did not
exist before copying. The registration commands were:

```sh
mkdir -p "$HOME/Applications"
ditto /tmp/simplemd-qlspike-build-b8791dd9/SimpleMDQLSpike.app \
  "$HOME/Applications/SimpleMDQLSpike.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f -v "$HOME/Applications/SimpleMDQLSpike.app"
pluginkit -m -A -D -vv -i com.jonathanreed.simplemd.qlspike.preview
open -n "$HOME/Applications/SimpleMDQLSpike.app"
pluginkit -m -A -D -vv -i com.jonathanreed.simplemd.qlspike.preview
pluginkit -e use -i com.jonathanreed.simplemd.qlspike.preview
```

The immediate query after `lsregister` had no matches. The query after `open`
listed one extension at
`/Users/jonathanreed/Applications/SimpleMDQLSpike.app/Contents/PlugIns/SimpleMDQLPreview.appex`,
UUID `52C01953-D4AF-4A47-8180-92B0E60ADF81`. The snapshot after selection has `+`
before the identifier. [Selected registration](evidence/registration-use.txt).

The fixtures are preserved in [fixtures](fixtures). The executed proxy commands were:

```sh
qlmanage -p /tmp/simplemd-qlspike-evidence-b8791dd9/fixtures/fixture.md
qlmanage -p /tmp/simplemd-qlspike-evidence-b8791dd9/fixtures/fixture.mdx
qlmanage -p /tmp/simplemd-qlspike-evidence-b8791dd9/fixtures/fixture.txt
mdls -name kMDItemContentType -name kMDItemContentTypeTree \
  /tmp/simplemd-qlspike-evidence-b8791dd9/fixtures/fixture.md \
  /tmp/simplemd-qlspike-evidence-b8791dd9/fixtures/fixture.mdx \
  /tmp/simplemd-qlspike-evidence-b8791dd9/fixtures/fixture.txt
```

Computer control opened a new Finder window, navigated to that fixture directory,
selected each file, and pressed Space. It captured each Quick Look panel, then
closed the panels and the new window. The original Downloads window and selection
remained. No new permissions were granted. The extension code contains no
Automation or Accessibility requests.

## Sandbox failure

The log interval begins at `2026-10-28 19:31:04` local time. The focused query was:

```sh
/usr/bin/log show --start '2026-10-28 19:31:04' \
  --style compact --info --debug \
  --predicate 'process == "SimpleMDQLPreview" OR subsystem == "com.jonathanreed.simplemd.qlspike" OR (eventMessage CONTAINS[c] "SimpleMDQLPreview" AND (eventMessage CONTAINS[c] "deny" OR eventMessage CONTAINS[c] "sandbox"))'
```

The relevant messages from the Markdown proxy are:

```text
19:31:24.783 secinitd: SimpleMDQLPreview[28379]: AppSandbox request successful
19:31:25.117 SimpleMDQLPreview[28379]: WKWebView created pid=28379
19:31:25.122 SimpleMDQLPreview[28379]: Preparing fixture.md pid=28379
19:31:25.192 WebContent[0] Application does not have permission to communicate with network resources. rc=1 : errno=34
19:31:25.192 WebProcessProxy::didFinishLaunching: Invalid connection identifier (web process failed to launch)
19:31:25.195 Preview failed: The operation couldn’t be completed. (SimpleMDQLSpike error 2.)
19:31:25.711 Sandbox: SimpleMDQLPreview(28379) deny(1) mach-lookup com.apple.backboard.hid-services.xpc
19:31:25.830 Sandbox: SimpleMDQLPreview(28379) deny(1) mach-lookup com.apple.webprivacyd
```

[Full timestamped excerpt](evidence/preview-md-system-excerpt.txt). Finder repeated
the failure with PID 29363 at 19:32:36. There is no `WKWebView didFinish` or
`Preview ready` message. No `Preparing fixture.mdx` or `Preparing fixture.txt`
message appears in the observed interval.

The network-permission message is a lead for the next experiment. This run does
not establish that one missing entitlement causes all three failures, or that
adding it would meet the no-network requirement. The two sandbox denials alone
fail the acceptance criterion even though sandbox initialization succeeded.

## Cleanup

Only `~/Applications/SimpleMDQLSpike.app` was registered and launched as the host.
Its embedded extension identifier was
`com.jonathanreed.simplemd.qlspike.preview`. The scratch build app in `/tmp` was
never launched or intentionally registered.

The executed cleanup restored the spike election to default, removed the plugin,
and unregistered the host before deleting it:

```sh
pluginkit -e default -i com.jonathanreed.simplemd.qlspike.preview
pluginkit -r "$HOME/Applications/SimpleMDQLSpike.app/Contents/PlugIns/SimpleMDQLPreview.appex"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -u "$HOME/Applications/SimpleMDQLSpike.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -u /tmp/simplemd-qlspike-build-b8791dd9/SimpleMDQLSpike.app
```

The extra unregister of the unregistered scratch copy returned `-10814`.
The final extension process had already exited when cleanup sent SIGTERM.
Python `shutil.rmtree` removed exactly these new paths:

```text
/Users/jonathanreed/Applications/SimpleMDQLSpike.app
/tmp/simplemd-qlspike-build-b8791dd9/SimpleMDQLSpike.app
/Users/jonathanreed/Library/Containers/com.jonathanreed.simplemd.qlspike
/Users/jonathanreed/Library/Containers/com.jonathanreed.simplemd.qlspike.preview
```

Final checks found `(no matches)` in PlugInKit, zero spike identifiers in the
LaunchServices dump, no `SimpleMDQL` processes, and no remaining paths above.
The original Quick Look provider list matched the final list. No existing app,
its files, or its registration was changed. [Cleanup commands](evidence/cleanup.txt),
[validation](evidence/cleanup-validation.txt).

Raw logs, fixtures, loose compiler outputs, and module cache remain only under
`/tmp/simplemd-qlspike-evidence-b8791dd9` and
`/tmp/simplemd-qlspike-build-b8791dd9`. The previous research directory is untouched.
There is no persistent spike registration or installed spike app.

## Next steps

1. Keep the macOS Accessibility hook until the Quick Look acceptance gate passes.
2. Investigate WebKit's network-permission launch requirement and the SDK 27.0
   sandbox denials in a separate experiment. Check whether documented entitlements
   can support local-only rendering without sandbox exceptions or network access.
3. Resolve MDX type coexistence with an already installed exporter. Declaring a
   second unrelated MDX UTI does not take ownership on this Mac. Test clean-machine
   resolution and a type-conformance strategy before choosing production UTIs.
4. After the placeholder passes, integrate the browser-safe render core and its
   sanitizer. Run the named Markdown, math, Mermaid, image, MDX, large-file, and
   non-Markdown fixtures before changing packaging or removing the hook.
5. Test the Intel slice on Intel hardware, then sign and notarize the final host
   with the future credentials. This spike does not qualify milestone 4 or release.

## Follow-up

Tested on 2026-10-28 in `t3/ae5e42e4`, after `git merge --no-edit
t3/b8791dd9` fast-forwarded to `e4c502e`. Changes remain uncommitted and confined
to this directory. No `app/src` file changed.

Both approaches show visible content in the `qlmanage -p` Quick Look host.
The WKWebView blank panel is resolved by the container and sizing change below.
The data provider also renders the actual SimpleMD parser through JavaScriptCore.
These are local extension results, not packaged SimpleMD or App Store approval.
Finder Space, Intel execution, MDX coexistence, the full acceptance fixture set,
and notarized distribution were not retested. Keep the Accessibility hook.

### A. View-based WKWebView

**Works for the placeholder fixture.** `PreviewController.swift` now returns an
`NSView` container, gives it an 800 by 600 preferred size, and adds a WKWebView
that follows the container's bounds with width and height autoresizing. The
extension retains the WKWebView separately. The host resized both views to
1290 by 757 points. Completion still runs from `didFinish`; no delay, extra
layer setting, GPU workaround, or private API was needed.

The successful configuration uses only these extension entitlements:

```xml
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.network.client</key><true/>
```

The host has only App Sandbox. The view still uses `.nonPersistent()` and disables
page JavaScript. It loads an HTML string with no base URL, escapes fixture text,
and sets `default-src 'none'; style-src 'unsafe-inline'`.

Direct [runtime evidence](evidence/followup/view-sizing-runtime.txt):

```text
19:50:19.953 Preparing fixture.md pid=46365
19:50:20.568 WKWebView didFinish ... frame=(0.0, 0.0, 1290.0, 757.0) root=(0.0, 0.0, 1290.0, 757.0)
19:50:20.568 Preview ready
```

Navigation readiness took 615 ms. [The panel screenshot](evidence/followup/view-sizing-panel.png)
shows the heading and escaped fixture text. Capture timestamps establish visibility
within four seconds of launching `qlmanage`, accounting for their one-second
precision. They do not measure first paint. The prior network-client-only scratch
run was reported blank by the owner. This follow-up changed the container,
autoresizing, and preferred size together, so it does not isolate which single
layout change was necessary.

The successful run still logged denials for `com.apple.backboard.hid-services.xpc`
and `com.apple.webprivacyd`. They are not fatal to this fixture. It also logged a
denied Unix-socket request to `/private/var/run/mDNSResponder`. No exception was
added for any of them. There was no packet capture or complete egress audit.

`network.client` is needed by the tested WKWebView launch configuration on this
Mac: the first spike without it could not launch WebContent, while adding it
allowed navigation. This follow-up does not establish that every macOS version
or WebKit configuration requires it. It is unnecessary for track B. The working
view needed no JIT entitlement, file-access exception, App Group, mach-lookup
exception, or sandbox removal.

The layout test solved the visible failure, so `limitsNavigationsToAppBoundDomains`,
other data stores, completion delays, and GPU/layer changes were not tried.

### B. Data-based HTML and JavaScriptCore

**Works for both static HTML and the actual parser.** `PreviewProvider.swift`
subclasses `QLPreviewProvider` and returns a `QLPreviewReply` of type `.html`.
`build.sh` sets `QLIsDataBasedPreview = true` and the matching principal class.
The extension and host each have only `com.apple.security.app-sandbox = true`.
There is no network, JIT, or temporary-exception entitlement. Quick Look handles
HTML display; the supplied page has no scripts and its CSP denies them.

The [static panel](evidence/followup/data-static-final-panel.png) shows headings,
a code block with inline token colors, and a fraction and superscript styled by
an inline `<style>`. The final static-provider run logged `Data preparing` at
19:56:45.301 and `Data ready bytes=896` at 19:56:45.302. The panel was visible at
the capture 3.596 seconds after launch. That is a capture bound, not first paint.
[Log](evidence/followup/data-static-final-runtime.txt).

The browser bundle imports the unchanged `app/src/shared/markdown-parser.ts`
through `parser-entry.ts`. Bun bundled 28 modules into 699,753 bytes with
`bun build --target browser --format iife`. It includes markdown-it and the
alert, footnote, KaTeX, and task-list plugins. `ParserRenderer.swift` evaluates
that trusted bundle in `JSContext` and passes the document as a function argument.
It provides no DOM, fetch implementation, or native callbacks. It never evaluates
the document as JavaScript. The extension renders Markdown with `html: false`
and the existing KaTeX trust and expansion limits.

The [actual-parser panel](evidence/followup/data-parser-panel.png) shows a heading,
inline-colored code, actual KaTeX output, and a Mermaid source block. Bundled
KaTeX CSS includes WOFF2 fonts as data URLs, with `font-src data:` in the CSP.
No font server is needed. The inline stylesheet is 368,260 bytes. The code
highlight callback is a small keyword fixture highlighter, not SimpleMD's Shiki
renderer. This proves parser/plugin execution and styled output, not render-core
or sanitizer parity. Diagrams remain code blocks in this mode.

For `followup.md`, bundle setup plus first render took 33.105 ms. HTML was ready
39 ms after `Data preparing`. The captured panel was visible within 3.508 seconds
of launch. [Runtime](evidence/followup/data-parser-runtime.txt).

Five separate extension processes rendered the unchanged 10,467-byte `app/README.md`.
Each process created a fresh JS context and then rendered five more times in that
context. Every warm output exactly equaled the first 11,606-byte HTML output.
There were five successful cold samples and 25 successful warm samples.

| Measurement | Median | Range |
| --- | ---: | ---: |
| Context creation, bundle read/evaluation, and first render | 63.889 ms | 47.209 to 74.091 ms |
| Subsequent render in that context | 7.517 ms | 6.890 to 11.252 ms |

[All samples](evidence/followup/parser-timings.json),
[README panel](evidence/followup/data-readme1-panel.png).
The screenshot bounds were 3.551 to 3.681 seconds after launch. Cold timing starts
after reading the Markdown and excludes process launch, the five warm validation
renders, CSS assembly, reply transfer, and host display. It is not a cold
end-to-end preview time. The host had load averages 11.36, 10.65, and 10.84 on 14
logical CPUs at the start; a compiler also ran during the samples. These are
feasibility timings, not a performance gate or a speed comparison. The native
binaries use the existing script's compiler defaults. No benchmark tuning was done.

The spike deliberately performs repeated renders and checks for fixture headings
and code blocks. Remove those measurements and fixture assertions before product
integration. Production also needs the specified sanitizer, bounded file size and
execution time, actual syntax highlighting, and the remaining acceptance fixtures.

### Security and source research

A strict CSP plus a `WKContentRuleList` blocking all HTTP and HTTPS resource loads
is useful protection for document content, but **does not guarantee zero network
access for the extension or its helper processes**. CSP controls document behavior;
a content rule list controls matching WebKit loads. Neither revokes the OS network
capability granted by `network.client`, controls native networking code, or proves
that every framework request uses that view's rules. `default-src` is a fetch
fallback, not a blanket navigation prohibition. Add `base-uri 'none'` and
`form-action 'none'`, reject external navigation and new windows, install blockers
before loading, and keep remote resources out of generated HTML. Those are
production requirements, not additional controls tested by the view placeholder.

[Apple's entitlement reference](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.network.client)
documents the outgoing network capability.
[WebKit's content-blocker description](https://webkit.org/blog/3476/content-blockers-first-look/)
explains matching resource requests and blocking their loads.
[The CSP specification](https://www.w3.org/TR/CSP3/#directive-default-src)
defines the fetch fallback; [form-action](https://www.w3.org/TR/CSP3/#directive-form-action)
is separate. [WebKit's app-bound domains description](https://webkit.org/blog/10882/app-bound-domains/)
explains navigation restrictions and treats local HTML strings as app-bound.
App-bound domains do not remove the network entitlement.

The data extension avoids granting that network capability and runs only the
bundled parser in JavaScriptCore. Its returned HTML still needs resource and link
policies because the system renderer is a separate security boundary. This spike
proves visible local content with no extension network entitlement, not a global
claim about all network activity by macOS.

Current public sources were read at pinned revisions:

- QLMarkdown `3a0cdcd40c5f53584a2fd9cf9dde6007276b31ce` now uses a data-based
  [PreviewProvider.swift](https://github.com/sbarex/QLMarkdown/blob/3a0cdcd40c5f53584a2fd9cf9dde6007276b31ce/QLExtension/PreviewProvider.swift)
  and declares the mode in
  [Info.plist](https://github.com/sbarex/QLMarkdown/blob/3a0cdcd40c5f53584a2fd9cf9dde6007276b31ce/QLExtension/Info.plist).
  Its [extension entitlements](https://github.com/sbarex/QLMarkdown/blob/3a0cdcd40c5f53584a2fd9cf9dde6007276b31ce/QLExtension/QLExtension.entitlements)
  include network client, an App Group, user-selected read access, a root-path
  read exception, and mach-lookup exceptions. Their presence does not prove the
  data provider requires them.
- FluxMarkdown `d2979de59ed45933397b7383ca7066f84a7547ad` uses a container view,
  preferred size, and autoresizing child WKWebView in
  [PreviewViewController.swift](https://github.com/xykong/flux-markdown/blob/d2979de59ed45933397b7383ca7066f84a7547ad/Sources/MarkdownPreview/PreviewViewController.swift).
  Its [release entitlements](https://github.com/xykong/flux-markdown/blob/d2979de59ed45933397b7383ca7066f84a7547ad/Sources/MarkdownPreview/MarkdownPreviewRelease.entitlements)
  include App Sandbox, network client, JIT, printing, selected-file/bookmark and
  Downloads access, plus home-relative path exceptions. This spike copied none
  of those broader permissions. The installed owner version is 1.36.582, so this
  public revision is source research, not proof of its installed implementation.

### Recommendation for milestone 4

Use **track A for the currently specified milestone 4 behavior**. Its blank panel
has a small layout fix, and the documented network-client entitlement admits
WebContent without temporary exceptions. It preserves the planned browser
render-core path and the ability to render Mermaid rather than showing source.
Before shipping, integrate that actual render core and sanitizer, install and test
resource/navigation restrictions, and run the full fixture set in Finder.
The placeholder is not proof of those remaining requirements.

Track B is a working fallback if the product accepts diagrams as code. It already
runs the shared parser and KaTeX without extension network capability or page
scripts. Choose it instead if denying the extension network capability is a hard
requirement. That choice changes the planned diagram behavior and acceptance set.

### Build, registration, and cleanup

Command Line Tools, Swift, and SDK versions match the first spike. No Xcode or
system software was installed. Both tracks built arm64 and x86_64 slices, signed
with `Developer ID Application: Jonathan Reed (AJ9VWBRNZN)`, hardened runtime,
and secure timestamps. Strict recursive signature verification passed. No keychain
prompt blocked signing. No notarization or Gatekeeper override was attempted.
The existing x86_64 compatibility-library warnings remain; Intel execution is untested.

Build from the repo root with a new output directory:

```sh
bash app/native/quicklook/build.sh \
  'Developer ID Application: Jonathan Reed (AJ9VWBRNZN)' \
  /tmp/simplemd-ql-followup-new view
```

Use `data` for the real parser or `data-static` for the static HTML fixture.
The parser mode requires the app's dependencies and Bun. This run temporarily
linked `app/node_modules` to an existing worktree with an identical `bun.lock`.
No dependency or source in that worktree was changed.

The [recorded test harness](evidence/followup/run-preview.sh) and
[window-list helper](evidence/followup/windows.swift) show the exact registration,
preview, capture, log, and trap commands. Each run used the same throwaway host
path and these two bundle IDs:

```text
~/Applications/SimpleMDQLFollowup.app
com.jonathanreed.simplemd.qlspike
com.jonathanreed.simplemd.qlspike.preview
```

There were nine temporary registrations: `view-sizing`, `data-static`,
`data-parser`, `data-readme1` through `data-readme5`, and `data-static-final`.
Each run registered the host with `lsregister -f`, launched it once, added its
embedded extension with `pluginkit -a`, selected the spike with `-e use`, and set
FluxMarkdown to `-e ignore`. An EXIT trap restored FluxMarkdown with `-e default`,
restored the spike election, removed the spike with `pluginkit -r`, unregistered
the host with `lsregister -u`, terminated only that run's preview processes, and
deleted the installed host and both spike containers. INT and TERM also route to
cleanup in the final harness. All unified-log calls used `/usr/bin/log`.
Screenshots use `screencapture -x -o -l` for the Quick Look window ID only.

Final cleanup and validation are recorded in
[cleanup-final.txt](evidence/followup/cleanup-final.txt). They cover the installed
host, both container directories, all six follow-up build directories and their
host copies, the research clones, temporary helpers, and the dependency symlink.
Scratch host unregistration can return `-10814` because those copies were never
registered. The owner's `/tmp/simplemd-ql-netclient` scratch copy was read only
and remains untouched. Retained evidence is under `evidence/followup/`.

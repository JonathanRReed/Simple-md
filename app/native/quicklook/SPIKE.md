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

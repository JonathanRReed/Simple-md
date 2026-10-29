# Quick Look spike record

The October 2026 spikes compared WKWebView with data-based Quick Look previews.
WKWebView failed to launch its content process with App Sandbox alone. The
data-based provider rendered HTML without a network entitlement. Milestone 4
uses that provider with the shared browser renderer in JavaScriptCore. Mermaid
fences show code in Quick Look.

The production build is `build-extensions.sh`. It builds universal preview and
thumbnail extensions with Command Line Tools. Each extension has App Sandbox
as its sole entitlement. `app/build/quicklook.mjs` signs and copies them before
electron-builder signs the app. `app/build/local-pack.mjs` verifies the final app
even if electron-builder skips its signing hook.

The WKWebView controller, throwaway host, parser-only renderer, alternate
entitlements and spike build scripts were removed after the security review.
Their exact sources and the raw spike receipts are archived at
`/Users/jonathanreed/Downloads/Simple-md/.audit/receipts/m4/evidence-archive/`.
The archive preserves their repository-relative paths. Nothing under `evidence/`
is executable.

The retained milestone reports are [M4](evidence/m4/REPORT.md) and
[final qualification](evidence/m4-final/REPORT.md). Their old raw receipt paths
resolve inside the archive above. The [security report](evidence/security/REPORT.md)
records the current fixes, package checks, provider routing and cleanup.

Run the manual qualification script with a packaged app and a new receipt folder:

```sh
bash app/native/quicklook/scripts/test-packaged.sh \
  app/release/mac-arm64/SimpleMD.app /tmp/simplemd-qualification-new
```

The script registers a temporary app, temporarily ignores FluxMarkdown if it is
installed, restores its default election in an EXIT trap, unregisters the test
extensions and app, removes their containers and clears the Quick Look cache.
It records thumbnail routing separately from preview success. Local execution
does not prove Intel, macOS 13 or clean-machine behavior. No notarization occurs.

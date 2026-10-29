# macOS Quick Look extensions

Feasibility spike done in milestone 0. Full build right after milestone 3. Security review required before merge.

## Build without Xcode

The Command Line Tools include Swift and the macOS SDK with `QuickLookUI`, `WebKit` and `QuickLookThumbnailing`. Compile each extension with `swiftc` and write its `Info.plist` by hand. The research spike compiled successfully with:

```sh
SDK="$(xcrun --sdk macosx --show-sdk-path)"
xcrun swiftc -sdk "$SDK" -target arm64-apple-macos13.0 \
  -parse-as-library -application-extension \
  -module-name SimpleMDPreview \
  -framework Cocoa -framework QuickLookUI -framework WebKit \
  -Xlinker -e -Xlinker _NSExtensionMain \
  PreviewController.swift \
  -o SimpleMD.app/Contents/PlugIns/SimpleMDPreview.appex/Contents/MacOS/SimpleMDPreview
```

Build both architectures for the matching release (arm64 and x86_64).

## Spike acceptance (milestone 0)

A Developer ID-signed `.appex` with a placeholder preview (done in M0; see SPIKE.md), inside a throwaway host app, must:

1. be discovered by `pluginkit -m`,
2. be admitted by the sandbox, and
3. render a fixture page when you press Space on a `.md` file in Finder.

Unregister it afterwards. If any step fails, stop and report the exact error before choosing another approach.

## Signing order

electron-builder skips `Contents/PlugIns` while signing (`app-builder-lib/out/mac/MacTargetHelper.js`). Copying an unsigned extension there is not enough.

- Build and sign the extension in `afterPack`, before the builder signs the outer app.
- Use the same Developer ID identity, a secure timestamp, the hardened runtime, and extension-specific sandbox entitlements.
- Sign inner code before each enclosing bundle. Keep the PlugIns exclusion so the builder does not replace the extension's entitlements.
- Verify the final app recursively, inspect the extension entitlements again, and notarize the whole app.

## Preview extension

Decided after the M0 spike (`app/native/quicklook/SPIKE.md`): a data-based preview.

- `Info.plist` sets `QLIsDataBasedPreview = true`. A `QLPreviewProvider` returns an HTML `QLPreviewReply`, and Quick Look displays it. There is no WKWebView in the extension and no script in the page.
- The extension evaluates the browser bundle of the render core in JavaScriptCore to produce HTML, including Shiki highlighting and KaTeX, then applies the author HTML policy before replying. JavaScriptCore has no DOM, so DOMPurify cannot run here. M4 must choose how to enforce the same policy (`docs/specs/sanitizer.md`) without a DOM, for example a policy walker over a pure-JS HTML tokenizer in the render-core bundle, and prove parity with DOMPurify's output on every sanitizer fixture with a differential test. CSP and Quick Look's script-free display are defense in depth, not the sanitizer. The spike measured about 7.5 ms per warm render and about 64 ms for context creation plus first render.
- The only entitlement is `com.apple.security.app-sandbox`. No network entitlement.
- The reply's CSP denies scripts and remote loads. KaTeX fonts are embedded as data URLs with `font-src data:`.
- Mermaid diagrams render as code blocks in Quick Look. If Pele can render SVG without a DOM later, inline that SVG.
- Works with the main app not running. Needs no Accessibility or Automation permission.
- Makes no network requests. Remote images are never fetched.
- Shows local images only where the sandbox grants access. Otherwise it shows a placeholder.
- Uses the system appearance with the default theme. It does not read the user config.
- Declares UTIs for Markdown and for MDX. MDX needs its own exported or imported UTI in `extendInfo`. Other installed previewers (for example FluxMarkdown) may already claim `.md` and `.mdx`; document how to pick SimpleMD in System Settings > Login Items & Extensions.
- Opening the file in the app works from Quick Look's standard "Open with SimpleMD" button.

## Thumbnail extension

Uses `QLThumbnailProvider`, drawing a Core Text title card from the first heading and opening lines. No WebKit.

## Removing the Accessibility hook

The hook, `peek.ts`, `peek-request.ts`, the `peek` intent, hide-on-close for peek windows, and the macOS parts of the Rust helper are deleted once the Quick Look extension passes the named fixture set: plain README, math, Mermaid, local image, MDX, a large file, and a non-Markdown file that must not be claimed.

Source: `.audit/research/e-os-integration.md`, Quick Look sections (local only).

## Static renderer integration contract

The M4 extension calls the synchronous global function
`renderStaticHtml(source, filePath, options): string` in JavaScriptCore.
`source` and `filePath` are strings. Options contain
`appearance: "light" | "dark"`, `truncated: boolean`, and
`invalidUtf8: boolean`. The result is a complete HTML document with no page
scripts or remote resources. The function must not require a DOM, Node, fetch,
or native callbacks.

Until the shared static renderer lands, `preview/render-stub.ts` escapes the
source into a `pre` element. It renders no Markdown, math, diagrams, or images.
Replace that build entry with the shared browser entry at integration. Preserve
the global synchronous signature and the size and encoding notices, then run
the sanitizer parity checks and repeat the packaged fixture checks.

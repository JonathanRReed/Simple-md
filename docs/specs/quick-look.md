# macOS Quick Look extensions

Feasibility spike in milestone 0. Full build right after milestone 3. Security review required before merge.

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

A Developer ID-signed `.appex` with a placeholder preview, inside a throwaway host app, must:

1. be discovered by `pluginkit -m`,
2. be admitted by the sandbox, and
3. render a fixture page in a sandboxed WKWebView when you press Space on a `.md` file in Finder.

Unregister it afterwards. If any step fails, stop and report the exact error before choosing another approach.

## Signing order

electron-builder skips `Contents/PlugIns` while signing (`app-builder-lib/out/mac/MacTargetHelper.js`). Copying an unsigned extension there is not enough.

- Build and sign the extension in `afterPack`, before the builder signs the outer app.
- Use the same Developer ID identity, a secure timestamp, the hardened runtime, and extension-specific sandbox entitlements.
- Sign inner code before each enclosing bundle. Keep the PlugIns exclusion so the builder does not replace the extension's entitlements.
- Verify the final app recursively, inspect the extension entitlements again, and notarize the whole app.

## Preview extension

- `QLPreviewingController` with a WKWebView. It runs the same browser bundle of the render core (see the render-core constraint in PLAN.md) and the same `sanitizeAuthorHtml()`.
- Works with the main app not running. Needs no Accessibility or Automation permission.
- Makes no network requests. Remote images are off here regardless of the app setting.
- Shows local images only where the sandbox grants access. Otherwise it shows a placeholder.
- Uses the system appearance with the default theme. It does not read the user config.
- Declares UTIs for Markdown and for MDX. MDX needs its own exported or imported UTI in `extendInfo`.
- Calls the completion handler after content is ready or after an error, with a bounded timeout.
- Opening the file in the app works from Quick Look's standard "Open with SimpleMD" button.

## Thumbnail extension

Uses `QLThumbnailProvider`, drawing a Core Text title card from the first heading and opening lines. No WebKit.

## Removing the Accessibility hook

The hook, `peek.ts`, `peek-request.ts`, the `peek` intent, hide-on-close for peek windows, and the macOS parts of the Rust helper are deleted once the Quick Look extension passes the named fixture set: plain README, math, Mermaid, local image, MDX, a large file, and a non-Markdown file that must not be claimed.

Source: `.audit/research/e-os-integration.md`, Quick Look sections (local only).

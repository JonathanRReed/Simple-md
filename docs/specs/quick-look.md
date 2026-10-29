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

### Render-core API

The browser entry, `app/src/shared/render-browser.ts`, exports this function and
exposes it as `globalThis.SimpleMDRenderCore.renderStaticHtml` in an IIFE bundle:

```ts
interface StaticRenderOptions {
  urls?: { baseUrl?: string; rootUrl?: string };
}
function renderStaticHtml(
  source: string,
  filePath: string | null,
  options?: StaticRenderOptions,
): Promise<string>;
```

Pass decoded UTF-8 source and either an absolute POSIX file path, a `file:` URL,
or `null`. The promise resolves to a complete HTML document. The default URL
context permits local images inside the document's folder. The native host can
supply `urls.rootUrl` for a project or Astro public folder to which it has access,
and `urls.baseUrl` to override the document folder. These are host-minted URLs,
never values taken from author HTML. The host still controls sandbox access.
Remote resources are always disabled, including generated Markdown images.

The document embeds the default light and dark theme, follows
`prefers-color-scheme`, and contains KaTeX CSS with all 20 WOFF2 fonts as data
URLs. Its CSP is exactly
`default-src 'none'; style-src 'unsafe-inline'; img-src data: file:; font-src data:`.
Mermaid fences become `<pre><code class="language-mermaid">` with escaped source.
Copy buttons are removed. No page script, external stylesheet or font file is
needed. Regenerate embedded assets with
`cd app && bun run scripts/generate-static-assets.ts` after a theme or KaTeX update.

`sanitizeAuthorHtmlStatic(html, options)` in `app/src/shared/sanitize-static.ts`
enforces the shared author policy. It parses an inert full HTML document, walks
the resulting tree, and uses the shared URL and srcset resolver. Generated nodes
use collision-free slots across the entire render tree. Each author unit is
sanitized before its generated children are inserted. Slots cannot be supplied
by source text. ID, name, heading and fragment maps are rebuilt after assembly.

The parser is pinned to [parse5 8.0.1](https://github.com/inikulin/parse5/releases/tag/v8.0.1).
Its published unpacked size is 337,099 bytes. Its
[HTML5 tree construction](https://parse5.js.org/) handles foster parenting,
formatting repair, namespaces and inert `noscript`. A SAX tokenizer would require
us to implement those rules. parse5 uses the already installed `entities`
dependency. Bare JavaScriptCore also lacks `URL`, so pinned `core-js-pure 3.51.0`
supplies that standard implementation only when the host lacks one. This keeps
the shared URL resolver unchanged. That URL module bundles to 48,690 minified
bytes. The complete sanitizer module, including the parser, URL implementation,
policy, fragment handling and slot assembler, bundles to 220,719 minified bytes
with Bun 1.4.4. It has no Node, Electron or DOM imports.

### Static sanitizer verification

`app/test/sanitize-static.test.ts` compares the static sanitizer with the existing
renderer DOMPurify path through `app/test/dom-runner.ts`. It covers every current
sanitizer fixture, all raw HTML fragments from all 41 corpus documents, and each
document's concatenated raw fragments. The current totals are 28 fixtures and
1,180 individual corpus fragments. All pairs must have equal normalized DOMs.

The serialization allow-list contains only these representation differences:

| Difference | Reason and normalization |
| --- | --- |
| Attribute order | Attributes form a map. Compare sorted name/value pairs. |
| Attribute quote style and entity spelling | Parse the output in Chromium and compare decoded values and text. |
| Void-element slash | HTML gives `<img>` and `<img />` the same tree. Compare parsed nodes. |

No element, attribute, URL, text or namespace difference is allowed in the
fixture/corpus differential. Comments become empty text boundaries; adjacent text
nodes are normalized before comparison, so their allocation does not affect it.

The deterministic fuzz test generates 4,000 hostile inputs with seed `0x51a71c`.
Both outputs are checked in Chromium for forbidden tags, foreign namespaces,
event handlers, author styles/classes, unsafe URLs and unprefixed IDs or names.
Output equality is required when the raw parser trees agree and DOMPurify's
tree survives HTML serialization. With Electron 45, 3,362 pairs are comparable,
624 have different raw parser trees and 14 produce DOMPurify trees that change
on serialization. Chromium's newer `<select>` parsing accepts children that
parse5's select insertion mode discards. Hoisting disallowed wrappers can also
produce nested paragraphs or anchors that an HTML parser repairs on reparse.
These are fuzz comparison limits, not semantic exceptions for the fixtures or
corpus. All 4,000 pairs still undergo the same safety assertions.

`app/test/static-html.test.ts` builds the browser IIFE with `bun build --target
browser`, runs it with only ECMAScript built-ins, and on macOS also runs it in
Apple's JavaScriptCore executable. It checks matching complete output with math,
Shiki, Mermaid code and local images, with no `document`, `window`, Node or fetch.
This proves the bundle's runtime contract. Finder display, extension sandbox
access, signing and packaged installation remain separate checks.

## Thumbnail extension

Uses `QLThumbnailProvider`, drawing a Core Text title card from the first heading and opening lines. No WebKit.

## Removing the Accessibility hook

The hook, `peek.ts`, `peek-request.ts`, the `peek` intent, hide-on-close for peek windows, and the macOS parts of the Rust helper are deleted once the Quick Look extension passes the named fixture set: plain README, math, Mermaid, local image, MDX, a large file, and a non-Markdown file that must not be claimed.

Source: `.audit/research/e-os-integration.md`, Quick Look sections (local only).

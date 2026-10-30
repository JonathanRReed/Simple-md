# Windows Explorer preview handler

Feasibility spike due by the end of milestone 2. Full build in milestone 7. The owner verifies it on Windows hardware.

## Spike (by the end of milestone 2)

CI builds a minimal Rust `IPreviewHandler` DLL that shows a fixed HTML page in WebView2 inside Explorer's preview pane (Alt+P), plus a per-user registration script with a matching uninstall script. The owner runs it on Windows and reports:

- whether WebView2 can start inside the low-integrity `prevhost.exe`,
- where its user data folder can live, and
- whether it renders and unloads cleanly when the selection changes.

**M7 fallback:** the handler always shows bounded, read-only native source while WebView2 starts. If the runtime is missing, startup fails in low integrity, rendering fails or the 15-second deadline expires, it keeps source visible and logs the reason. Never disable the preview sandbox to make rendering work.

## Lifecycle

1. `Initialize` reads the stream through short reads up to 4 MB plus one truncation byte, decodes UTF-8 with replacement and records the access mode. It releases the stream before returning.
2. `SetSite` keeps the host interface for accelerator forwarding.
3. `SetWindow` and `SetRect` create and resize a plain container HWND. A read-only EDIT control and WebView2 are siblings inside it. Both use its client rectangle; only the active preview is visible.
4. `DoPreview` displays literal source in a monospace, scrollable read-only EDIT control, capped at 128 Ki characters, in an 11-point Consolas font with a fixed-pitch system fallback. DPI changes resize the children and recreate the font. Inputs above the shared 1,900,000-byte HTML limit, or truncated inputs, stay on native source without starting WebView2. A private one-shot timer queues WebView2 startup on the owning STA after `DoPreview` returns. A second timer bounds startup and rendering to 15 seconds. Both cancel on fallback or unload. The controller stays hidden until the final static document loads.
5. A generation counter cancels stale async work when the selection changes.
6. `Unload` closes the controller, releases COM references, drops document data, and destroys the child window.

All COM and window work stays on the owning STA. Never block the host message loop on parsing or WebView2 startup. Keep foreign calls outside mutable Rust borrows that could re-enter.

## Content rules

- Stream-only content at first, with no neighboring images, because a stream may not come from a real folder.
- The app build bundles `app/src/shared/render-browser.ts` into one browser IIFE and embeds it in the DLL. It uses the same `renderStaticHtml` and `sanitizeAuthorHtmlStatic` as Quick Look, with `filePath = null`. There is no file bridge or image embedding.
- The host calls `ExecuteScript` in an empty `about:blank` document with document scripting disabled. WebView2 permits host-issued script even with `IsScriptEnabled = false`. Source enters as a JavaScript string literal. Quotes, backslashes, controls, U+2028/U+2029 and `<` are escaped; other Unicode stays intact. Invalid UTF-8, including surrogate encodings, becomes replacement characters before scripting. It is never evaluated or inserted into the bootstrap DOM. The bundled parser treats MDX as text.
- Only the bootstrap enables web messages. The host accepts its string result once, verifies the origin, disables messages and navigates to the completed static HTML. The final page has no scripts or native bridge. Its CSP is Quick Look's exact `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`. Inline CSS follows `prefers-color-scheme`.
- Resource requests receive synthetic 403 responses; only the two host-issued document loads and in-page fragments may navigate. New windows are blocked. WebView2 may report a synthetic data URI for `NavigateToString` at `NavigationStarting`, even though the resulting document is `about:blank`. Author DOM does not exist before either host navigation starts, so it cannot consume a pending host load. Host objects, developer tools, dialogs, context menus and browser accelerator keys are disabled. Accelerator events go to the host frame, preserving its handled status. Remote and neighboring images never load. Outputs above 1,900,000 UTF-8 bytes retain source, below WebView2's 2 MB `NavigateToString` limit.
- Reuse `LocalAppDataLow/SimpleMD/Preview/UserData/<pid>` across previews in each host process. Cache the COM environment on its STA and keep an empty hidden WebView alive between selections so the browser process can be reused. Unload closes the document controller but leaves the host cache intact. On startup, sweep profiles whose PID is no longer alive, including profiles from older per-preview builds. Keep profiles when process liveness cannot be established. Do not delete profiles while the browser still holds them.
- Log failures, fallback reasons and lifecycle milestones, without a line for every COM call. Truncate `preview.log` at 1 MiB before appending the next entry. Record the integrity RID once per process.

## Install

- Register per-user (HKCU), without admin rights, from NSIS using the same PowerShell scripts as standalone development. Cover `.md`, `.markdown`, `.mdown`, `.mkd` and `.mdx`, matching Open With. Save and restore previous per-user handlers only while each association remains owned. Uninstall removes registration and retries LocalLow cleanup. Both scripts refuse reparse points in the preview path or its ancestors before changing registration. Cleanup removes nested junctions as links. LocalLow supplies the inherited low-integrity label; the installer never changes integrity labels.
- Detect Evergreen WebView2 through Microsoft's documented registry version values during install. Read them without loading the preview DLL or changing machine-wide keys. Offer the Microsoft bootstrapper download when missing. Silent installation keeps source preview without prompting. Store logs and per-host browser profiles under the inherited low-integrity `LocalAppDataLow/SimpleMD/Preview` folder.
- Skip preview registration on native ARM64 and other non-x64 Windows systems. The app installer succeeds and records the reason in its hook log.
- PowerToys Peek uses its own Markdown previewer before any shell handler, so do not promise Peek integration.

## Removal

The experimental bare-Space Windows hook is deleted in milestone 0.

Source: `.audit/research/e-os-integration.md`, Windows section (local only).

## Verification

The Windows CI job checks clippy with warnings denied, portable content tests,
a hidden-window COM lifecycle test with real asynchronous startup and deterministic
fallback/stale-generation checks and rendered title/script settings when the runtime is present, a stable browser PID and one profile after repeated preview/unload cycles, client bounds, DPI font recreation, browser accelerator settings, log truncation, oversized-input fallback, and standalone plus NSIS install/uninstall. Installer tests plant parent and child junctions, verify refusal before registry changes, compare target bytes and ACLs, and test nested-link cleanup. Runtime detection must also succeed with an invalid DLL without loading it.
The Electron-free JS differential compares the embedded browser bundle with the
Quick Look API on shared fixtures and inspects hostile output as parsed HTML.
None of these establishes low-integrity Explorer rendering. The owner follows
`app/native/windows-preview/TESTING.md` using the CI artifact.

WebView2's host-script behavior is documented in Microsoft's
[IsScriptEnabled reference](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings).

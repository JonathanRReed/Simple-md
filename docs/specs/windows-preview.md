# Windows Explorer preview handler

Feasibility spike due by the end of milestone 2. Full build in milestone 7. The owner verifies it on Windows hardware.

## Spike (by the end of milestone 2)

CI builds a minimal Rust `IPreviewHandler` DLL that shows a fixed HTML page in WebView2 inside Explorer's preview pane (Alt+P), plus a per-user registration script with a matching uninstall script. The owner runs it on Windows and reports:

- whether WebView2 can start inside the low-integrity `prevhost.exe`,
- where its user data folder can live, and
- whether it renders and unloads cleanly when the selection changes.

**Fallback:** if WebView2 cannot render in the preview host without disabling the sandbox, Windows v1.0 ships Open With plus the Jump List, and the preview handler moves to 1.x. Never disable the preview sandbox to make rendering work.

## Lifecycle

1. `Initialize` keeps a bounded input stream and the access mode.
2. `SetSite` keeps the host interface for accelerator forwarding.
3. `SetWindow` and `SetRect` create and resize a child HWND.
4. `DoPreview` reads the stream, starts an STA WebView2 controller, and renders inert Markdown with the shared browser bundle.
5. A generation counter cancels stale async work when the selection changes.
6. `Unload` closes the controller, releases COM references, drops document data, and destroys the child window.

All COM and window work stays on the owning STA. Never block the host message loop on parsing or WebView2 startup. Keep foreign calls outside mutable Rust borrows that could re-enter.

## Content rules

- Stream-only content at first, with no neighboring images, because a stream may not come from a real folder.
- Bundled scripts only. No remote requests. Document scripting is off and MDX never executes.
- Use a WebView2 user data folder compatible with low integrity, not the install directory, and clean it up.

## Install

- Register per-user (HKCU), without admin rights, from the NSIS installer. Uninstall removes it.
- Use the Evergreen WebView2 runtime. Detect it during install and offer the bootstrapper if it is missing.
- PowerToys Peek uses its own Markdown previewer before any shell handler, so do not promise Peek integration.

## Removal

The experimental bare-Space Windows hook is deleted in milestone 0.

Source: `.audit/research/e-os-integration.md`, Windows section (local only).

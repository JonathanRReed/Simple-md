# Windows preview spike

This is the M2 feasibility spike for Windows x64. It shows a fixed HTML page and at most the first 2,048 bytes of a stream as escaped text. It does not render Markdown yet. It does not install SimpleMD or change the default application for `.md`.

The owner must establish whether Evergreen WebView2 can render inside the low-integrity Explorer preview host. Compilation alone does not answer that question. Never disable the preview sandbox or add `--no-sandbox` to make it work.

## Install

1. On Windows x64, download `windows-preview-spike` from the desktop workflow's artifacts. Extract it to a local folder you can keep until uninstall. Keep the DLL, both scripts, `TESTING.md`, and `REVISION.txt` together. Record the source commit from `REVISION.txt`.
2. Install the [Evergreen WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if it is missing. The spike logs startup failures but does not install the runtime.
3. Close existing preview panes. Open a normal, non-administrator 64-bit Windows PowerShell session in the extracted folder. Run:

   ```powershell
   Get-ChildItem -File | Unblock-File
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   The execution policy override applies only to this process. The script writes HKCU, creates `%USERPROFILE%\AppData\LocalLow\SimpleMD\PreviewSpike`, and marks it low integrity. It does not write HKLM or use `regsvr32`. Both scripts and the DLL resolve the `LocalAppDataLow` known folder, including redirected profiles. The log records the actual user data path.
4. The DLL must stay at the registered path. To change builds or move the folder, uninstall first. A second install refuses to overwrite the saved association.

## Exercise Explorer

1. Create a local `.md` file. Use a locally created file so Windows' Internet-file preview restrictions do not obscure the result:

   ```powershell
   @'
   # Preview spike
   This should be visible as text.
   <script>alert("must not execute")</script>
   <img src="https://example.com/must-not-load.png">
   '@ | Set-Content -Encoding utf8 "$env:USERPROFILE\Desktop\simplemd-spike.md"
   "# Second file`nDifferent preview text" | Set-Content -Encoding utf8 "$env:USERPROFILE\Desktop\simplemd-spike-second.md"
   ```

2. Open File Explorer on the Desktop. Press **Alt+P** to show the preview pane. Select `simplemd-spike.md`. If needed, enable "Show preview handlers in preview pane" in Folder Options, View.
3. Expect a heading, "SimpleMD preview spike", and the file's literal text. The script and image markup must remain text. There must be no alert or image request from the document. Resize the pane. Use Tab and Shift+Tab to move focus into and out of it.
4. Switch between the two Markdown files rapidly, select a non-Markdown file, then switch back. Close the preview pane and Explorer window. Repeat once. Check for old text appearing after a selection change, a blank pane, a hung Explorer, crashes, or a WebView2 error.
5. If the old handler stays loaded, close preview panes and stop `prevhost.exe` in Task Manager. Explorer starts a new host on the next selection. You can instead use `-RestartPreviewHost` on install or uninstall. This stops all preview hosts in your session, including previews for other file types. It does not restart Explorer itself.
6. PowerToys Peek has its own Markdown previewer. Test Explorer's Alt+P pane, not Peek.

## Send back the result

Copy `%USERPROFILE%\AppData\LocalLow\SimpleMD\PreviewSpike\preview.log` before cleanup. If the profile is redirected, use the location printed by install and the user data path recorded in the log.

Report:

- The source commit, Windows version and architecture, WebView2 runtime version, and whether PowerToys or another Markdown previewer is installed.
- Whether the fixed heading and each file's text appeared. Include a screenshot and any visible error.
- Whether resizing, focus, rapid selection changes, pane closure, and reopening worked.
- The log file, including the process integrity RID, user data path, `NavigationCompleted`, `Unload complete`, and HRESULT failures. Low integrity is `0x1000`. A result at medium integrity, `0x2000`, does not establish sandbox feasibility.
- Whether `User data removed` appears or cleanup was deferred. Check that uninstall can remove any remaining `UserData` directories after closing the host.

The log uses UTC timestamps, process and thread IDs, handler IDs and generations. It records byte counts, not document text or source paths. WebView2 may leave locked profile files until its browser process exits. `Unload` attempts cleanup; uninstall retries. The diagnostic log remains so you can send it back. If there is no log, send the install output and describe the preview pane. The DLL may not have loaded, or the low-integrity directory may not be writable.

## Remove

1. Close all Explorer preview panes. From the extracted folder, run in the same normal 64-bit PowerShell session:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -RestartPreviewHost
   ```

2. Reopen Explorer and select the test file. The spike must no longer appear. The previous preview association should work again if one existed. The script preserves registry values another application changed after installation and prints what it kept.
3. Save the log. If the script reports locked data files, wait for the WebView2 processes belonging to the preview host to exit, then delete the spike's `UserData` folder. Delete the extracted artifact folder and the two Desktop test files. Finally, remove `LocalLow\SimpleMD\PreviewSpike` if you no longer need its log. Do not remove other SimpleMD data.

## Scope and fallback

The handler uses `IPreviewHandler`, `IInitializeWithStream`, `IObjectWithSite`, `IOleWindow`, and a COM class factory. `ThreadingModel=Apartment`, non-agile COM objects, and an STA check keep window and WebView2 work on the host thread. Startup is asynchronous. Each startup callback checks the generation; a controller arriving after `Unload` is closed. `Unload` releases the input stream, site, controller and child HWND. DLL unload accounting includes factories, server locks, pending startup and registered callbacks.

Document scripting, web messages, host objects, developer tools and context menus are disabled. A content security policy forbids external content and scripts. Web resource requests receive a synthetic 403 response, navigation is restricted to `about:blank`, and new windows are blocked. No browser arguments or sandbox overrides are supplied. This is stream-only, with no neighboring file access or remote images.

The scripts use the dedicated CLSID `{a8b4f9c2-6e75-4eaa-9a1d-e4276f01d937}`, the existing x64 preview host AppID `{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}`, the per-user PreviewHandlers value, and `.md\shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}`. They save the previous per-user association under `HKCU\Software\SimpleMD\PreviewSpike`. Uninstall restores it only while the association still points to this spike, removes owned values, and removes newly created keys only when empty. Machine-wide registrations remain untouched. See Microsoft's [preview handler registration guidance](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-register-a-preview-handler).

If WebView2 cannot render inside `prevhost.exe` without disabling the sandbox, Windows v1.0 ships Open With plus Jump List. The preview handler moves to 1.x. A successful spike is the base for milestone 7, where shared Markdown rendering, runtime installation and NSIS integration belong.

## Build checks

From the repository root:

```sh
cargo fmt --manifest-path app/native/windows-preview/Cargo.toml --check
cargo check --locked --manifest-path app/native/windows-preview/Cargo.toml --target x86_64-pc-windows-msvc
cargo clippy --locked --manifest-path app/native/windows-preview/Cargo.toml --target x86_64-pc-windows-msvc --all-targets -- -D warnings
cargo test --locked --manifest-path app/native/windows-preview/Cargo.toml
bun run check:rust
actionlint .github/workflows/desktop.yml
```

On a Mac, the Windows target checks types but does not link or execute the DLL. The portable tests check escaped, bounded text and malformed UTF-8. CI uses an independent Windows x64 job to lint, run the content tests and a COM interface and stream lifecycle test, link the release DLL, parse the PowerShell scripts, check an HKCU install/uninstall round trip, and upload the artifact. The existing packaging jobs do not depend on it. CI does not establish that WebView2 renders in low-integrity Explorer. That is the owner test above.

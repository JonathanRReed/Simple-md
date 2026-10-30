# M7 Windows owner checks

CI checks compilation, hidden-window COM behavior and per-user installation.
Only this test establishes whether WebView2 works in Explorer's low-integrity host.
Never change the preview sandbox or add browser sandbox flags.

## Install

1. On Windows x64, download `SimpleMD-Windows-M7` from the linked Actions run.
   Record the run URL and `windows-preview/REVISION.txt`. Extract the artifact.
2. Run the unsigned SimpleMD installer from `app/release` as your normal user.
   Windows may warn about the unsigned build. Install for the current user.
   If offered, download and run the Microsoft Evergreen WebView2 bootstrapper.
   Installation completes without it; source preview works without WebView2.
3. Close existing preview panes. If an older preview handler remains loaded,
   close `prevhost.exe` in Task Manager once. This also closes other previews.
4. Confirm SimpleMD appears in Open With for `.md`, `.markdown`, `.mdown`, `.mkd`
   and `.mdx`. Open a document in SimpleMD, then check its taskbar Jump List for
   Recent and New Window. Clearing SimpleMD recents must preserve other apps' history.

For development instead, keep the standalone DLL and scripts together and run
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` from a
normal 64-bit PowerShell. Keep `paths.ps1` beside both entry scripts. Use its matching `uninstall.ps1` before deleting it.
Do not install both copies at once. On ARM64 and other non-x64 Windows systems,
preview registration is skipped. Check the installer hook log for the reason;
the app installer still succeeds.

## Exercise Explorer

1. Create local files, avoiding Internet-file preview restrictions. Include:
   - A README with headings, lists, a table and code.
   - Math, a Mermaid fence and an MDX file with imports, JSX and expressions.
   - Raw `<script>`, an `onerror` image and a `javascript:` link.
   - Remote and neighboring images, an empty file and a file larger than 4 MB.
2. In File Explorer, press Alt+P and select each file. If needed, enable
   "Show preview handlers in preview pane" in Folder Options, View.
   For nonempty files, expect formatted Markdown or readable literal source.
   An empty file may have an empty pane.
   Math may be formatted; Mermaid stays code. MDX never runs. Images from the
   network or neighboring files must not load. No alerts, browser windows or network requests.
3. Resize the pane and scroll. Check that the right and bottom edges are visible
   and that the native source scroll bars disappear when formatted content appears.
   Move Explorer between monitors with different scale factors. Native source
   should keep its 11-point monospace size, and formatted content should fit the pane.
   Ctrl+P, F5 and Ctrl+F must not open browser UI or reload the document. Switch Windows between light and dark appearance.
   Tab into and out of the pane. It must remain read-only and must not take focus
   when the selected file changes.
4. Change selections rapidly, including non-Markdown files. Close and reopen the
   pane and Explorer. Check for stale text, hangs and crashes. Large input reads
   stop at 4 MB; native source display stops at 128 Ki characters with a notice.
   Inputs above 1,900,000 decoded UTF-8 bytes stay on source without starting
   WebView2. Smaller inputs can also stay on source if rendered HTML exceeds that limit.
5. Test Explorer Alt+P, not PowerToys Peek, which has its own Markdown previewer.

## Check the log and report

1. Before uninstalling, copy
   `%USERPROFILE%\AppData\LocalLow\SimpleMD\Preview\preview.log`.
   With redirected profiles, use the location printed by standalone installation.
2. Find `Process integrity RID=0x1000`. A `0x2000` result is medium integrity and
   does not establish Explorer sandbox compatibility.
3. For formatted preview, find `Static preview visible NavigationCompleted success=true`.
   For source preview, find `Native fallback:` with its reason or HRESULT.
   Startup or render deadlines expire after 15 seconds. Source remains visible
   during startup. Find `Unload complete`. Under `Preview\UserData`, each active
   host PID should have one folder, even after repeated selections. Profiles stay
   until the host exits; a later host startup removes profiles for dead PIDs.
   The log is capped near 1 MiB and retains one integrity line per process until
   that line ages out at truncation.
4. Send the source commit, Actions run URL, Windows version/architecture,
   WebView2 version from the log, screenshots, log, and the results of each step.
   Note other installed Markdown previewers. Logs contain byte limits, process/thread
   IDs and generations, not document contents. If no log exists, send installation
   output, `%TEMP%\SimpleMD-preview-install.log` and a screenshot of the pane.

If formatted preview works at RID `0x1000`, qualify the WebView2 path. If startup
fails there while literal source works, select the built-in native source fallback
for that environment. A blank pane, stale selection, hang or crash fails M7.
Do not weaken the sandbox to obtain a formatted preview.

## Remove

1. Save the log, close preview panes, then uninstall SimpleMD in Windows Settings.
   For the standalone copy, run
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -RestartPreviewHost`.
2. Confirm SimpleMD's preview association disappears for all five extensions.
   Previous per-user handlers should return. Changes made by other apps after
   installation must survive. The `HKCU\Software\SimpleMD\Preview` backup and
   LocalLow `SimpleMD\Preview` folder should disappear. Both scripts must refuse
   a junction at `SimpleMD`, `Preview` or an ancestor. Resolve the junction manually
   before retrying; the scripts must never relabel or delete its target.
3. If WebView2 still holds files, wait for its preview processes to exit and remove
   only that Preview folder. Report the deferred cleanup. Delete the test files
   and extracted standalone artifact after uninstall.

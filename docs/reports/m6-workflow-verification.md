# M6 workflow verification

Worktree: `t3-ea1f6119`, branch `t3/ea1f6119`, starting revision `a6b3952`.

## Initial reproduction

The native build ran first. Dependencies were installed from the frozen lockfile,
Electron's install script supplied its local executable, and the app was rebuilt.
All five reported smoke failures passed individually on this fresh build:
`m6-security-git-is-lazy`, `m6-security-cli-unavailable`,
`m6-security-change-size`, `m6b-watch-highlights`, and `tabs-windows`.

`bun run test:cli` also passed all seven scenarios, including cold start.
The current script already calls `buildTestCli()` and supplies `SMD_CLI_APP`
and `SMD_CLI_APP_ROOT` for cold start. Its receipt names
`native/target/cli-tests/release/simplemd`. The reported LaunchServices failure
does not reproduce at this revision.

Saved sessions already start with optimistic Git status. No mount-time Git
probe is needed. A separate inconsistency remains after an explicit failed
read: native and renderer menus use the failed result to disable or remove
the action, despite the document retaining its path. The watch smoke test
also expects that disabled state. These disagree with the requested retry
behavior.

The window-count failure does not reproduce individually. The existing code
destroys an emptied move source and any closed window when another document
window exists. It retains only the last closed window, as the tray contract
requires. Full-suite verification is pending.

Local logs are under `.audit/m6-finish/`.

## Menu correction

`changesMenuState()` now supplies the native item and its cache key with the
same enabled, checked, and tooltip values. A document path enables the action,
including after a failed Git read. The renderer palette uses the path too.
Git still runs only on explicit use. The watch smoke case now expects the
enabled retry and verifies the outside-repository message.

The retry check also reproduced a checked-state bug. Electron toggles a
checkbox before calling its handler. A repeated identical failure leaves the
menu cache unchanged, so the checkbox stayed checked. The handler now restores
the confirmed state while the asynchronous result is pending. The new smoke
assertion failed before this fix and passed afterward. The menu unit checks
and typecheck passed.

The exploratory full run passed 89 of 90 cases, including all five reported
failures in sequence. Its one failure was caused by rebuilding `dist` while
the suite was launching `bytes-roundtrip-binary-looking`, temporarily removing
`main-app.mjs`. This run is excluded from final acceptance. The two acceptance
runs will use a fixed build and separate temporary blog copies.

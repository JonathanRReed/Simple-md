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

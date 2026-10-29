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

## Functional acceptance

All five reported smoke cases passed individually after the menu fix. Both
required full smoke runs passed **90/90** cases. Each used a separate copy of
`/Users/jonathanreed/Downloads/Personal-Site/src/content/blog`. SHA-256 checks
confirmed the originals and both copies were unchanged. Logs and copy paths
are in `.audit/m6-finish/smoke-runs.json`, `smoke-1.log`, and `smoke-2.log`.

The initial menu, CLI-unavailable, size, and window-count errors do not
reproduce on the fresh build, either alone or in sequence. Stale output is
a possible explanation, not an established cause of those earlier results.
The confirmed product defects were the disabled Git retry and its stale
checkbox. The watch test's expectation of a disabled retry was wrong.
The current window-count assertion and lifecycle implementation agree, so
neither was changed. Optional CLI startup remained non-fatal.

The CLI verifier now accepts a case filter, so
`bun run test:cli cold-open` checks cold start alone. It passed, as did the
full seven-scenario `bun run test:cli`. Both receipts identify
`native/target/cli-tests/release/simplemd` and record the Electron executable
in `SMD_CLI_APP` and app directory in `SMD_CLI_APP_ROOT`. `buildTestCli()`
builds this binary with `cli-test-hooks`. The release CLI's packaging check
confirms it contains none of `SMD_CLI_RUNTIME`, `SMD_CLI_APP`, or
`SMD_CLI_APP_ROOT`. Release platform launch behavior was not changed.

| Check | Result |
| --- | --- |
| `bun run build:native`, run first | Passed |
| `bun run typecheck` | Passed, repeated after the CLI filter change |
| `bun run test` | 345 passed, 1 skipped, 0 failed |
| `bun run test:corpus` | 41 documents, 0 semantic edits |
| `bun run test:packaging` | 21 passed, 1 skipped, 0 failed |
| `bun run check:rust` | Passed |
| `bun run test:rust` | 7 passed across the Rust binaries |
| `bun run build` | Passed before the acceptance smoke runs |
| `bun run test:cli cold-open` | 1/1 passed |
| `bun run test:cli` | 7/7 passed |
| Full smoke, blog copy 1 | 90/90 passed |
| Full smoke, blog copy 2 | 90/90 passed |

The skipped test requires an actual packaged Quick Look app. These checks
do not qualify a signed distribution bundle or Windows hardware.

The host has 14 logical cores. Smoke run 1 started at load averages
19.42, 21.70, 20.58 and ended at 18.28, 20.67, 20.32. Run 2 ended at
32.95, 27.19, 23.08. The perf gate will record its own load and failures.

## Lifecycle failure found by full perf

The first full perf attempt, at `bf80058`, exposed a product defect during
`resident-closed/bom.md`. Late renderer notifications outlived the last tab.
The `smd:perf-marker` handler dereferenced `currentSession().documentId`
after that session had been removed. Electron displayed a critical alert
with a `TypeError` at `dist/main-app.mjs:3905:64`. The `smd:editing` and
`smd:document-ready` handlers had the same unsafe assumption.

The stalled process was verified as this worktree's test instance, PID 96792,
then killed so the harness could retain its logs, count the case as failed,
and continue. This was not a valid sample for that fixture. The first attempt
has 20 failed samples and a failed correctness gate. Its receipt is
`.audit/perf-vnIN7o/receipt.json`.

The three handlers now ignore notifications when no current session exists.
The new `tabs-last-close-late-notifications` smoke case closes the last tab,
sends all three stale notifications, verifies the hidden resident window and
disabled Git action, then reopens the file in the same window. It passed in
isolation, as did `quit-with-late-renderer-markers` and all five originally
reported smoke cases. Typecheck passed. No window-count assertion was relaxed.

The first perf attempt also failed cold starts, closed math reopen, the 20 MB
first screen, and memory. All typing gates passed. Load averages were
20.70, 24.82, 22.49 at receipt creation and 25.09, 25.48, 23.55 at completion.
The corrected candidate must repeat functional acceptance and a full perf
attempt before the final verdict.

## Corrected candidate acceptance

At `0282ee2`, every source check in the table above passed again, including
345 unit tests, the 41-document corpus with zero semantic edits, 21 packaging
tests, and 7 Rust tests. The existing packaged-app test remained skipped.
The CLI passed all seven scenarios and cold start passed alone.

Both full smoke runs passed **91/91**, including the new late-notification
case and every originally reported failure. Each used a separate temporary
blog copy. The originals and both copies retained their SHA-256 hashes.
The final logs and copy paths are in
`.audit/m6-finish/lifecycle-checks.json`, `lifecycle-smoke-runs.json`,
`lifecycle-smoke-1.log`, and `lifecycle-smoke-2.log`.

The second perf attempt will use this corrected bundle. It is a new candidate
qualification, not a controlled speed comparison with the first attempt.

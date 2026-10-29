# M6 workflow verification

Functional acceptance passes. Performance qualification remains blocked by two timing gates.

Branch: `t3/ea1f6119`, based on `m6-workflow`. Starting revision: `a6b3952`.
Final code change: `0282ee2`. Corrected perf candidate: `9611d64`, with a clean
working tree. Later report-only commits do not change the tested code.

## Findings and fixes

After the native build, frozen dependency install, Electron setup, and fresh app
build, all five reported smoke failures passed individually before any source
edit. The CLI suite also passed before edits. The earlier menu and count errors
cannot be assigned a confirmed cause without their original build and receipts.
Stale output is possible, but unproven.

| Reported case | Finding and disposition |
| --- | --- |
| `m6-security-git-is-lazy` | Fresh build passed. Saved sessions already start optimistically. The marker test proves mounting and menu inspection do not run Git; explicit use does. Shared `changesMenuState()` now supplies both the native item and its cache key. |
| `m6-security-cli-unavailable` | Fresh build passed. CLI startup failure is already non-fatal. Its isolated test confirms the document renders and the log reports `CLI unavailable`. No startup assertion was weakened. |
| `m6-security-change-size` | Fresh build passed. Explicit use still shows the 2 MB cap message and creates no highlights. The Git action now follows the active document path even after a failed read. |
| `m6b-watch-highlights` | The disabled-menu expectation after an outside-repository read was wrong. The action must remain available for retry. The test now verifies the enabled action, clear outside-repository message, and unchecked state after retry. |
| `tabs-windows` | The original count failure did not reproduce. Existing counts and destroy/hide rules were correct, so neither was relaxed. Full perf then exposed a real related lifecycle defect: late notifications dereferenced a removed session after the final tab closed. That defect is fixed and covered separately. |
| CLI cold start | `buildTestCli()` and both gated dev launch overrides were already present and worked on a fresh build. The verifier now supports `cold-open` alone and records the test CLI and dev launch paths in its receipt. Release launch behavior is unchanged. |

Two product bugs were confirmed in the menu flow. A failed Git read disabled or
removed retry despite a saved path. Electron also toggles a checkbox before its
handler runs, so repeated identical failures could leave it checked when the
menu cache saw no result change. The native item and cache now use the same
projection, the palette uses the path, and the handler restores the confirmed
checked state while awaiting the result. The new retry assertion failed before
the checkbox fix and passed afterward.

During perf attempt 1, an Electron critical alert reported `TypeError` in
`smd:perf-marker` at `dist/main-app.mjs:3905:64`. The final tab had closed, so
`currentSession()` was absent. `smd:editing` and `smd:document-ready` had the
same unsafe assumption. All three handlers now ignore notifications for a
closed session. `tabs-last-close-late-notifications` closes the last tab, sends
all three notifications, checks the hidden resident window and disabled Git
action, and reopens the file. It passes alone and in both full suites.

## Checks

| Check | Result |
| --- | --- |
| `bun run build:native`, run first | Passed |
| `bun run typecheck` | Passed |
| `bun run test` | 345 passed, 1 skipped, 0 failed |
| `bun run test:corpus` | 41 documents, 0 semantic edits |
| `bun run test:packaging` | 21 passed, 1 skipped, 0 failed |
| `bun run check:rust` | Passed |
| `bun run test:rust` | 7 passed across the Rust binaries |
| `bun run build` | Passed |
| `bun run test:cli cold-open` | 1/1 passed |
| `bun run test:cli` | 7/7 passed |
| Originally reported smoke cases, isolated | 5/5 passed |
| Late-notification and late-quit cases, isolated | 2/2 passed |
| Full smoke with blog copy 1 | 91/91 passed |
| Full smoke with blog copy 2 | 91/91 passed |

All source checks, CLI scenarios, and both full smoke suites were repeated after
the lifecycle fix. The skipped test requires an actual packaged Quick Look app.
These checks do not qualify a signed distribution bundle or Windows hardware.

Each full smoke run used a separate temporary copy of
`/Users/jonathanreed/Downloads/Personal-Site/src/content/blog`. SHA-256 checks
confirmed that the originals and both copies were unchanged. The CLI receipts
identify `native/target/cli-tests/release/simplemd`, built with `cli-test-hooks`,
and record the Electron executable in `SMD_CLI_APP` and app directory in
`SMD_CLI_APP_ROOT`. Packaging checks confirm the release CLI contains none of
`SMD_CLI_RUNTIME`, `SMD_CLI_APP`, or `SMD_CLI_APP_ROOT`.

An earlier exploratory smoke run was discarded after a concurrent rebuild
removed `main-app.mjs` during one launch. Both final acceptance runs used a
fixed bundle and passed every case.

## Full performance attempts

Both commands were unfiltered `bun run perf:gate`, with 20 samples per timing
case and all typing and memory checks. Both exited 1. These are separate
candidate qualifications on a shared host, not a controlled speed comparison.

| Gate, p95 from 20 samples | Attempt 1, `bf80058` | Attempt 2, `9611d64` | Target |
| --- | --- | --- | --- |
| Cold, fresh profile | 1157.2 ms, fail | 682.3 ms, pass | < 800 ms |
| Cold, reused profile | 1154.5 ms, fail | 696.3 ms, pass | < 800 ms |
| Closed-window math reopen | 191.7 ms, fail | 234.1 ms, fail | < 150 ms |
| 20 MB first screen | 456.2 ms, fail | 475.0 ms, fail | < 200 ms |

Attempt 1 also failed correctness during `resident-closed/bom.md`. The test
process was blocked on the verified uncaught-exception alert. Only that process,
PID 96792 in this worktree, was killed so the harness could retain its logs and
continue. Its 20 incomplete samples and 21 related errors remain failures in
the receipt. One-document memory had no eligible stable window; its final
physical footprint was 374.27 MB. The extra-document memory gate could not be
qualified without that baseline. All 36 typing gates and tab switching passed.

Attempt 2 has **zero correctness errors and zero failed samples**. The formerly
stalled BOM case completed all 20 samples. The only failed gates are closed
math reopen and the 20 MB first screen. One-document memory passed at
139.11 MB. Five tabs used 145.74 MB, or 1.66 MB per extra document. Tab switch
p95 was 32.3 ms against 50 ms. All 36 typing gates passed.

The host has 14 logical cores. Receipt load averages, in 1-, 5-, and 15-minute
order:

| Attempt | Start | End |
| --- | --- | --- |
| 1 | 20.70, 24.82, 22.49 | 25.09, 25.48, 23.55 |
| 2 | 15.54, 19.22, 21.08 | 18.84, 15.92, 17.55 |

The host was busy. The remaining timing failures are not proven to be caused
by contention. M6 does not meet every performance gate.

## Local evidence

- [Perf attempt 1](../../.audit/perf-vnIN7o/receipt.json)
- [Perf attempt 2](../../.audit/perf-EJVuDi/receipt.json)
- [Final source checks](../../.audit/m6-finish/lifecycle-checks.json)
- [Isolated smoke cases](../../.audit/m6-finish/lifecycle-isolation.json)
- [Blog copies and hashes](../../.audit/m6-finish/lifecycle-smoke-runs.json)
- [Full smoke 1](../../.audit/m6-finish/lifecycle-smoke-1.log)
- [Full smoke 2](../../.audit/m6-finish/lifecycle-smoke-2.log)
- [Full CLI](../../.audit/m6-finish/lifecycle-test-cli.log)
- [Isolated cold CLI](../../.audit/m6-finish/lifecycle-cli-cold.log)

All changes are local WIP commits. Nothing was pushed and no PR was opened.
The research/gpu-memory worktree was not modified.

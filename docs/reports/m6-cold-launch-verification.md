# M6 cold-launch verification

Quiet-host A/B qualification is pending. The owner replaced the ten loaded-host A/B runs with trace-ordering evidence and asked that the M5 checkout remain available. No cold p95 pass or speedup is claimed.

The tested code is `5ef41ddfb7734e5db6bef166e4c9b5d935d35573`. The original M6 code is `1c3388ada75321206bb382316f8d4503d09791f9`; the before snapshot uses `fc477d7`, which adds diagnostics without changing startup behavior. M5 is `37f196ca9a5f4c6babb3edf9d465dd1df983fa58`.

The reported 600 ms regression did not reproduce as a stable M6-specific delay. Original M6 already finished its initial document open before starting the CLI server. Its runtime preparation took a few milliseconds after first-readable. Static CLI, export, Git and drag-export imports evaluated before app-ready. The extra block-change parser evaluated in the worker before first-readable, but the measured parser construction itself took about 2 ms. These observations do not establish the cause of the earlier 600 ms gap.

The change removes optional work from startup:

- File and URL launches schedule CLI startup on an idle tick after the initial open completes. Blank and background launches wait for renderer readiness and then an idle tick, allowing the CLI to deliver the first document.
- CLI import and startup failures are non-fatal. Shutdown waits for pending startup and closes a server that finishes starting during shutdown.
- Staleness still requires an owned Unix socket and a refused connection. A 100 ms timer bounds the probe; timeout does not authorize deletion. Private directory and state permissions, secrets, framing, Windows ACLs and the single-instance rule remain intact.
- CLI server, export jobs, Git baselines, drag exports and block changes load on demand. Export jobs receive the main-owned render function, keeping RenderClient and its relative worker URL in the entry bundle. Export source snapshots are captured before awaiting the import.

The build wrapper now marks `main-import-start`. The interval to `main-bundle-loaded` includes loading, compilation and evaluation, excluding earlier Electron process startup. `SMD_PERF=1` enables module and startup markers. Human-readable `SMD_TRACE` details remain separate from structured marker names so existing log-count assertions still work.

Six supporting launches used fresh profiles and compile caches, the same Electron executable and fixture, and an unpurged OS file cache. Every launch completed its document assertions and exited successfully. Times below are single launches, not p95 values. Load is the one-minute average at launch.

| Launch | Load | Main import, ms | External first-readable, ms |
| --- | ---: | ---: | ---: |
| M5 1 | 47.4 | 11.59 | 1112.3 |
| Original M6 1 | 46.6 | 9.88 | 997.4 |
| Patched M6 1 | 46.6 | 11.64 | 978.6 |
| Patched M6 2, stale socket | 46.6 | 9.96 | 960.8 |
| Original M6 2 | 47.1 | 8.97 | 823.8 |
| M5 2 | 47.1 | 9.34 | 1793.5 |

Main import time did not improve measurably and cannot account for 600 ms. Startup outside that interval varies much more. Earlier diagnostic runs saw load rise from 37 to over 200 and native exit stalls in both versions. Their failed receipts remain available; they are not qualification samples.

For patched file launches, every CLI marker follows first-readable. The other optional modules are absent throughout both cold launches. These offsets use the process marker clock, with first-readable set to zero.

| Marker | Patched M6 1, ms | Patched M6 2, ms |
| --- | ---: | ---: |
| CLI startup scheduled work begins | +6.99 | +3.97 |
| Runtime module evaluates | +8.73 | +5.20 |
| Server module evaluates | +8.76 | +5.23 |
| Runtime preparation begins | +9.17 | +5.51 |
| Connect probe begins | Not needed | +6.25 |
| Connect probe ends | Not needed | +7.71 |
| Runtime preparation ends | +10.84 | +8.70 |
| Listener ready | +12.12 | +9.66 |
| CLI ready | +12.17 | +9.69 |

The second patched launch seeded an owned stale socket with a state file naming PID 1. The refused connection allowed cleanup, after first-readable. In original M6, the CLI modules evaluated about 562 to 585 ms before first-readable and block changes about 53 to 65 ms before it. Actual server startup was already after first-readable. These offsets locate events; they do not measure evaluation duration.

Separate workflow launches prove deferred modules still work. All four launches below completed their assertions and exited 0. Offsets are from each launch's first-readable marker.

| Workflow | Deferred module evaluation after first-readable |
| --- | --- |
| Explicit Git action | Git +34.77 ms |
| Watched file update | Block changes +147.42 ms; later explicit Git +289.19 ms |
| Git HEAD highlights | Git +16.71 ms; block changes +126.84 ms |
| Drag export | Drag export +16.66 ms; export jobs +17.83 ms |

| Required check | Latest result |
| --- | --- |
| `bun run build:native`, first | Passed |
| `bun run typecheck` | Passed |
| `bun run test` | 345 passed, 1 skipped, 0 failed |
| `bun run test:corpus` | 41 documents, 0 semantic edits |
| `bun run test:packaging` | 21 passed, 1 skipped, 0 failed |
| `bun run check:rust` | Passed |
| `bun run test:rust` | 7 passed |
| `bun run build` | Passed |
| `bun run test:cli` | 7/7 passed, including cold start |
| Full smoke with a blog copy | 90/91; one native exit timeout; isolated recheck passed |

The skipped packaging test requires an actual packaged Quick Look bundle. These development-app checks do not qualify packaged macOS or Windows runtime behavior.

The first full smoke run on the fixed worker-owner code passed 88/91. Two cases completed their assertions and screenshots but hit native exit deadlines. The third counted the same document-send detail in both diagnostic formats. Normalizing the structured marker name fixed that count without weakening the assertion. All three failed cases then passed individually. The initial attempt before the worker-owner fix was stopped after the CLI exposed an incorrect worker URL; its logs remain separate.

The final full smoke run passed 90/91. `edit-modes-undo-save` completed its assertions and screenshot, stopped its worker and destroyed its window, then missed the native process-exit deadline. Its isolated recheck passed 1/1. The full-suite receipt remains red. No further full-suite retry was made for the recurring exit stall. The final command was `SMD_PERF=1 SMD_BYTE_BLOG_DIR=<copy> bun scripts/verify-smoke.ts` from `app/`.

Every full smoke run uses a temporary copy of `/Users/jonathanreed/Downloads/Personal-Site/src/content/blog`. The originals are never passed to the verifier. SHA-256 inventories confirm all 15 original files remained unchanged in every full smoke run.

Raw evidence is under `.audit/m6-cold-start/`:

- `trace-comparison-final/receipt.json` contains every event, source revision, bundle and lockfile hashes, load averages and ordering assertions. `summary.json` contains the extracted timings. The current main bundle matches both patched launch hashes.
- `workflow-traces/` contains the four workflow logs, exit receipts, screenshots and module-order summary.
- `checks-verified/` contains the latest required-check logs, the 90/91 receipt, its successful isolated recheck and blog-copy integrity receipts. `checks-final/` retains the earlier 88/91 run and its three successful rechecks. `diagnostics/` retains the original interleaved traces, including failed runs.
- `comparison.html` contains the supporting trace chart.

M5 remains at `/tmp/simplemd-m5-cold-OQsEFU`, clean at `37f196ca9a5f4c6babb3edf9d465dd1df983fa58`, with dependencies, Electron and a build ready. Diagnostic-only source edits were removed after tracing. The orchestrator can run the final five alternating 20-sample rounds per branch when the host is quiet. No push or pull request was created.

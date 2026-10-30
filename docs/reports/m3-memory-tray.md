# M3 memory and tray measurements

The final full `perf:gate` passes. It collected 960 successful opens, zero failed opens, 18 passing typing cases and five settled memory samples. Physical footprint was 142.0 MB median. Settled tray opens were 22.8 to 30.5 ms p95 across all 11 normal fixtures.

Rapid hide/reopen bursts still reproduce a native tail near 500 ms. This work qualifies the settled resident tray state and preserves the rapid case as a failing diagnostic. It does not claim an app speedup from changing the dwell or a repair to Chromium's rapid window-ordering path.

Measured app revision `542741d219245411e7bbe6b8327b7bba925a230d`, branch `t3/ebe4adc1`, with a clean working tree. Dist SHA-256 `e48a0852503a189afceab3c5c87dc4ce0ee2b52cdce78e3978a9374302f1b293`. Every dist file still matches the full receipt. Later changes only correct a descriptive cache string and add this report. No push or PR. The renderer files owned by the other agent, `app.ts`, `live.ts` and `diagrams.ts`, were untouched.

The roughly 400 MB samples are real transient GPU footprint charges. The archived 416.1 MB sample contains 297.8 MB in GPU, about 69 MB in Browser, 41 MB in Renderer and 8 MB in Utility. There is one renderer. The native peek helper was disabled by the measurement profile. Compile-cache or parser heap growth cannot explain a GPU-only jump. The exact GPU allocation subtype was not identified.

The old 159.2 to 188.8 MB comparison contains about 21.9 MB more GPU footprint, 6.9 MB more Browser footprint and 0.9 MB more Renderer footprint. These are historical process medians, not additive causal estimates. The high receipts are stamped `f97dc1e` on the branch named `m3-speed`, before its worker-speed merge. A fresh M0 run also reached 424.3 MB transiently, with 311.0 MB in GPU. The peaks predate M3.

The original five-second sleep did not establish settlement. The collector now waits five seconds, records 20 one-second observations, and gates the final five only when PIDs stay fixed and each process spans at most 2 MB. A stable high plateau remains eligible and can fail the 200 MB gate. An unstable window fails rather than selecting low samples. All raw observations remain. Four of 75 attribution attempts were unsettled; their receipts are retained. M0 and YAML repeats supplied the missing settled controls.

All memory values below are decimal MB. Median is the median of launch medians. p95 and process medians pool the five final observations from each eligible launch. Browser includes the Node worker thread when present. Each command was `bun run perf:gate --only=memory --samples=5`. Revision order alternated forward and backward across five rounds. The same 90 KB document, Live mode, collector and fixtures were used with each revision's locked dependencies.

| Point | Commit | Settled/attempted | Median | p95 | Browser | GPU | Utility | Renderer |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| M0 | `0f1469f` | 5/7 | 156.2 | 156.8 | 63.4 | 45.1 | 7.8 | 40.1 |
| M1 tip | `d421f3f` | 5/5 | 161.8 | 163.2 | 68.9 | 45.0 | 7.8 | 40.4 |
| M2 | `dbb6280` | 5/5 | 164.3 | 165.0 | 70.9 | 45.2 | 7.7 | 40.4 |
| M3a | `f97dc1e` | 5/5 | 164.4 | 164.7 | 71.0 | 45.0 | 7.8 | 40.7 |
| m3-speed | `6a3977c` | 5/5 | 164.8 | 165.4 | 71.3 | 45.0 | 7.8 | 40.2 |
| Memory candidate | `bedc213` | 5/5 | 143.3 | 144.2 | 50.0 | 45.0 | 7.8 | 40.4 |

Growth appears mainly in M1 and M2. The matched M0-to-m3-speed difference is 8.6 MB, largely in Browser. M2, M3a and m3-speed overlap. There is no demonstrated session-refactor or worker-speed memory regression beyond that noise.

The following effects are medians of paired launch differences. A negative number means less footprint. Source revisions and every pair are in the JSON appendix.

| Change | Qualified pairs | Median change, MB | Pair range, MB |
| --- | ---: | ---: | ---: |
| Separate MDX validation from parsing; import the parser on demand | 5 | -5.49 | -6.70 to -4.13 |
| Load YAML only for frontmatter | 5 | -1.02 | -1.18 to 0.43 |
| Load KaTeX only for math tokens | 5 | -3.23 | -3.77 to -2.13 |
| Skip unused full-document renders for Live opens | 4 | -4.52 | -5.62 to -2.38 |
| Start the worker only for a real render request | 5 | -7.13 | -8.45 to -5.69 |

The YAML result is small and uncertain, with one pair increasing. The Live-only comparison had one rejected GPU window, leaving four qualified pairs. A separate lazy-command-module prototype showed no win and was removed. The final worker strategy uses the existing worker-on-request mechanism. Live receives source without an unused prepared read render; switching to Read requests the complete render. Source, Split, MDX ranges, read-only files and exports retain their checks.

The native hidden-tail profile spends most sampled main-thread time in AppKit window enumeration waiting for a WindowServer transaction. This matches Chromium 156's queued occlusion update, which enumerates `NSApp.orderedWindows`. See [the pinned Chromium implementation](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/content/app_shim_remote_cocoa/web_contents_occlusion_checker_mac.mm). This is an inference from the stack and Chromium source.

Five alternating batches of 20 opens per state reproduced the distinction:

| Tray preparation | Median batch p95 | Batch p95 range | Opens |
| --- | ---: | ---: | ---: |
| Repeated 30 ms hide/reopen bursts | 523.3 ms | 505.2 to 533.5 ms | 100/100 successful |
| One-second resident tray dwell | 25.2 ms | 24.0 to 33.4 ms | 100/100 successful |

Alternating individual short and long dwells also removed the short-arm tail. Sustained ordering churn matters. The default resident-hidden setup now has a one-second dwell before the external barrier; `--hidden-dwell-ms=30` retains the original diagnostic. `--compare-hidden-dwell` records both states. The gate still uses the parent's external monotonic clock and subtracts nothing.

Renderer source timestamps exposed about 485 to 500 ms of marker queueing behind main in rapid cases. No rAF timeout fallback was added. Every one of the final run's 1,500 readable markers, including untimed setup opens, reported a visible native window. A scoped powerSaveBlocker probe still had 530.2 ms p95. Dock-call guards, opaque-window and occlusion-switch probes did not remove the burst tail and were not retained. The stacks and long-idle open do not support adding NSProcessInfo activity or an always-on keep-awake workaround.

Removing eager worker startup did not break the first read transition. Twenty fresh Live-to-Read launches, with the worker absent before the request, passed at 68.8 ms p95. The candidate's first Read after five minutes hidden took 82.3 ms with reopen requests staggered between apps.

Idle controls used two cohorts with launch order reversed, each with five 60-second intervals per side. CPU time sums Browser, GPU, Utility and Renderer. Mach counters use this host's `125/3` timebase, verified against [XNU task accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c) and [task power accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c). Profiles match the gate and disable the native peek helper.

| Idle measure | m3-speed | Candidate |
| --- | ---: | ---: |
| Median CPU seconds per 60 s | 0.02179 | 0.02752 |
| Median CPU, percent of one core | 0.0363% | 0.0459% |
| CPU range, percent of one core | 0.0108 to 0.1712% | 0.0107 to 0.1611% |
| Median interrupt wakeups per 60 s | 139 | 135.5 |
| Package-idle wakeups across ten intervals | 1 | 0 |

The median paired CPU difference was +0.00037 seconds per minute, with five positive and five negative intervals. Its range was -0.06010 to +0.03288 seconds. There is no consistent idle increase in these controls. This is CPU and wakeup evidence on a shared host, not a watt-hour battery measurement. No keep-awake blocker or new background switch shipped.

The first idle cohort exposed a real quit bug after its CPU intervals ended. Late marker IPC accessed the document registry after cleanup cleared it, opening Electron's uncaught-exception alert. Native sampling and the alert identified the line. Main now rejects renderer IPC after quitting starts and ignores late activation. The new smoke case sends markers while quitting. Twenty subsequent first-read launches and the final smoke/full-gate processes exited normally. The first failed pilot and both idle cohorts remain in the receipts. The first cohort's simultaneous reopen timings are excluded; the reversed cohort staggered reopens. Its candidate and control exited without intervention.

The first full smoke attempt passed 54/57. Three paste cases failed before injection because Electron returned a clipboard item without MIME types and the driver tried to reconstruct it. The driver now skips empty items while backing up the available formats. The three focused paste cases and the full smoke suite then passed.

The final full gate at `542741d` reports:

| Gate family | Result |
| --- | --- |
| Cold fresh / reused p95 | 506.9 / 507.4 ms, both under 800 |
| Visible normal p95 range | 20.2 to 23.8 ms |
| Settled tray normal p95 range | 22.8 to 30.5 ms |
| New-file normal p95 range | 21.2 to 37.7 ms |
| A-to-B-to-A p95 range | 23.4 to 28.1 ms |
| 2 MB / 20 MB first-screen p95 | 40.0 / 171.3 ms, both under 200 |
| Memory | 142.0 MB median, 142.0 MB p95; five settled samples from 20 observations |
| Typing | All 18 calibrated cases pass with exact saved bytes |
| Correctness | 960/960 opens, zero failures |
| Tabs / two document panes | Not applicable; not implemented |

Fresh checks passed: native build first; typecheck; 239 tests; the 41-document corpus with 230 assertions; 14 packaging tests; build; all 57 smoke cases; and the full performance gate. All 15 blog files were tested from a temporary copy. Every original blog hash still matches its initial digest.

One-minute load averages for those checks are below. The full performance receipt itself starts at 14.99, 10.99, 9.99 and ends at 13.45, 13.25, 11.93 on 14 logical cores. The host was shared. Absolute gates passed under that load; the cross-revision latency figures are not causal speedup claims.

| Check | Result | Start load | End load |
| --- | --- | ---: | ---: |
| `build:native` | passed | 8.20 | 8.20 |
| `typecheck` | passed | 8.20 | 8.20 |
| `test` | passed | 8.20 | 8.01 |
| `test:corpus` | passed | 8.01 | 8.17 |
| `test:packaging` | passed | 8.17 | 8.17 |
| `build` | passed | 8.17 | 8.17 |
| `smoke` | passed | 8.17 | 14.38 |
| `perf:gate` | passed | 14.38 | 13.45 |

[Full receipt](/Users/jonathanreed/.t3/worktrees/Simple-md/t3-ebe4adc1/.audit/perf-9H4eZN/receipt.json), [attribution and check appendix](m3-memory-tray.json), and [local raw artifacts](/Users/jonathanreed/.t3/worktrees/Simple-md/t3-ebe4adc1/.audit/m3-closeout) contain the samples, failures, per-process breakdowns, cache state, source bindings, checks and load averages. Archive source hashes were rechecked unchanged. The archives are not separate git checkouts, so their containing-checkout dirty hash is not source-cleanliness proof; the explicit archive revision, source hashes, lockfile hashes and dist hashes bind them. The final full receipt is from the clean measured checkout. These are development Electron production bundles; ASAR and installed-product runtime were not measured.

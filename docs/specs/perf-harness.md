# Performance gate harness

Milestone 0. Extend the existing driver (`app/src/main/driver.ts`), `app/test/performance.test.ts`, `app/bench.ts` and `app/scripts/verify-smoke.ts`. Do not add a second automation framework.

## Command

`bun run perf:gate` runs every gate on the local machine and writes a JSON receipt. The PR description links that receipt.

The receipt records: revision, dirty patch hash, lockfile hash, dist and ASAR hashes, Electron and Node versions, host model, macOS build, power source, thermal state, display refresh rate, load average, the cache state of each run, every sample, and every failure.

## Fixtures

Commit fixtures with their source digests: small README, medium (about 90 KB), huge (about 2 MB), 20 MB ceiling, math-heavy, diagram-heavy, many code fences, long lines, Unicode and astral characters, CRLF, mixed line endings, BOM, and MDX (copied from a blog post with permission).

## Named states

Measure each state separately and never mix them:

- process cold with a fresh profile
- process cold with a reused profile
- resident visible
- resident hidden (tray), after a one-second dwell before the external start. The prior hide and native window-ordering transition must finish before measuring a resident open. Use `--hidden-dwell-ms=30` to reproduce the separate rapid hide/reopen diagnostic. The receipt records the dwell, and no latency is subtracted after the external start
- resident closed, after Command-W closes every tab, confirms the last window is hidden with an empty layout, and dwells for one second. Reopen through the same renderer and include this state in the normal-file warm gate
- resident with a new file (cache miss)
- an A to B to A revisit

Control each of these explicitly: main and worker compile caches, the disk render cache, the Shiki language cache, and retained DOM.

## Markers

Time from a monotonic clock started outside Electron. Record:

- file-open arrival
- read and hash
- worker queue, parse, highlight and serialize
- renderer receive and mount
- **first readable**: a named driver marker that does not wait for highlighting or diagrams
- fully highlighted
- diagrams ready
- ready for input

A wrong-file or failed render fails the run. Screenshots and text assertions happen outside the timed region.

## Gates

| Gate | Statistic |
| --- | --- |
| Warm open to first readable, normal files | p95 of at least 20 samples < 150 ms |
| First screen readable, files up to 20 MB | p95 of at least 20 samples < 200 ms. Files over 20 MB open in Source mode with no gate. |
| Cold launch to first readable | p95 of at least 20 samples < 800 ms |
| Switch to an already-open 100k-character tab | Read and Live measured separately, p95 < 50 ms each |
| Typing, 100k-character document, one pane and two visible panes | Event Timing API `duration` (input to next paint) for keydown and beforeinput at the top, middle and end of the file, in live, source and side-by-side modes. Gate: conservative p95 editor excess over a matched empty-textarea control is at most one display frame plus 8 ms, from at least 40 trusted keys per case. Unreported sub-16 ms events count as under 16 ms. Raw values stay in the receipt. |
| Memory, five medium tabs | `(fiveTabMB - oneDocMB) / 4 <= 25` MB per extra document, using the same settling rule as one-document memory. |
| Memory, one document, settled | max(stable window median, final total) of physical footprint summed over every app process < 200 MB (decimal). Summed RSS is recorded beside it but is not a gate. Windows uses private working set. |

Memory uses the medium fixture in Live mode. After five seconds, record 30 observations at one-second intervals. Gate the most recent five consecutive observations in which the process IDs stay fixed and each process spans at most 2 MB. The window must end within the last five observations and have the same process ID set as the final observation. Gate the maximum of its median total and the final total. If no such window exists, the gate fails. Apply the same rule to five medium tabs and require `(fiveTabMB - oneDocMB) / 4 <= 25` MB per extra document. Keep every observation in the receipt, including transient GPU allocations. Do not force garbage collection or choose the lowest samples.

Typing runs also cover burst input, selection movement, backspace, undo, paste and IME composition, and they verify the final saved bytes.

## Where gates run

- Absolute gates run on the owner's MacBook. Never register that machine as a self-hosted runner on this public repository.
- Hosted CI runs the same harness only to catch relative regressions beyond a noise band measured from repeated control runs. It also catches missing output and broken markers.
- Until the end of milestone 3, a PR must not regress any gate. From then on, the gates block merges.
- Milestone 0 measures the real app's physical footprint, and the owner reconfirms the 200 MB target before it becomes blocking.

## Head-to-head (v1.0)

Use one external method for every app: high-frame-rate screen capture from launch or open to visible text, on three named fixtures, for SimpleMD, QLMarkdown, Typora, Obsidian and the VS Code preview. Record results; the owner judges them.

Source: `.audit/research/b1-performance.md`, "CI perf-gate harness design" (local only).

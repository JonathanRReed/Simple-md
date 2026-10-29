# Worker performance implementation

Measured source 1d7db6b57e8610751eb3b14c6acca8e3d55c7ef1, branch t3/e9c7db51. The final source tree was clean. Dist SHA-256 4b1db3a353ce3ea62455ba4277e0e48b724c8f853ab4f84524998d6fa9006684. No push or PR.

The full performance gate exits 1. All 960 opens succeed. Every first-screen gate passes, including 20 MB at 185.6 ms p95. All visible, new-file normal and revisit gates pass. All 18 calibrated typing cases pass. All 11 hidden-window warm-open gates fail. Memory passes 200 MB and misses the 150 MB stretch goal.

## Changes

1. The worker supplies SHA-256 through node:crypto. The browser core retains its portable hash. Native hashing reduces the matched 20 MB median from 589.0 to 417.9 ms. Use the tables for exact percentiles and spread.
2. Shiki imports its core, the lazy language-loader table and only github-light/github-dark. Unsupported languages stay plain. Oniguruma remains the engine. On the actual 64-fence fixture in fresh Node workers, five alternating samples per engine produced identical HTML. Setup medians were 29.5 ms Oniguruma and 7.6 ms JavaScript. The 704 highlight calls per sample took 76.9 ms median with Oniguruma and 114.4 ms with JavaScript. The broader ten-language check also favored Oniguruma throughput. This is a highlighting result, not a first-readable speedup.
3. Readable blocks arrive without Shiki. The renderer requests enrichment after its first-readable double-rAF callback. Highlight patches retain the readable block identity. Nested quoted fences and MDX child fences receive patches. Cached highlighted payloads need no deferred highlighting.
4. Markdown above 262,144 UTF-16 units starts with 8,192 UTF-16 units, then a full document parse resolves context and streams block batches. The HTML batch target is 64 KiB. The renderer appends new nodes and yields a frame between updates. Large author wrappers, lists, tables and fences remain indivisible. MDX retains its full parse before initial delivery to preserve incomplete-source behavior. The initial prefix is provisional until the complete parse resolves trailing reference definitions and block boundaries.
5. Edit renders retain identities by mapped source-line ranges, with content fingerprints separate from identity. A full parse resolves document dependencies, while the resolved-token cache avoids regenerating unchanged HTML. Worker-to-main and main-to-preload responses carry changed blocks plus order/range metadata. Worker requests include the client's retained fingerprints to survive stream, navigation and export interleavings. The first renderer edit response establishes a full baseline. Subsequent responses omit unchanged HTML. Incoming edit requests still contain full source strings.
6. Render, highlight and MDX parse caches share a 16 MiB admission budget across main and worker through atomic reservations. Entries charge twice their serialized UTF-8 size and a per-entry allowance where applicable. LRU eviction crosses cache namespaces within each thread. If another thread owns the remaining budget, admission can decline. Worker shutdown releases reservations. This bounds charged derived entries, not the whole process, Shiki grammars, active render state or DOM. The browser core has a local fallback without SharedArrayBuffer or Atomics.
7. The full source transfer to the worker now waits until the continuation request for large Markdown. This reduced the matched 20 MB median and p95 again. Complete source bytes still reach the renderer in the initial payload. Exports always render the entire source and never consume a prefix.

No changes to diagrams.ts, live.ts, byte preservation, URL containment or author sanitization. Main, preload and renderer changes are confined to stream/delta plumbing, block mounting and export completeness. No dependency changes.

## Alternating gate measurements

Each stage has five alternating pairs of frozen production bundles. Each side contributes 20 samples per case, four samples per pair. The command uses the existing perf:gate runner through bun run bench.ts --perf-gate --only=resident-visible,resident-new-file-miss --fixtures=small.md,ceiling.md --samples=4 after swapping the frozen dist tree. Full receipts retain bundle hashes, host load and every sample. Four-sample individual receipts fail the minimum-count gate by design. Aggregated comparisons have 20 samples per side.

A/B receipt source revisions identify the working orchestration checkout. The recorded dist hash identifies the executable side. These staged bundles are not final-product qualification. The final unfiltered run identifies the clean source commit above. The readable-stage bundle includes the render-completion sentinel correction after its checkpoint. No staged bundle is claimed as an installed, signed or packaged app.

Cells are median / p95 [minimum, maximum], in milliseconds. Percentiles use the harness's nearest-rank method. Source parsing, full-source IPC and renderer scheduling remain costs. Small differences whose ranges overlap are inconclusive. Shiki and identity changes do not demonstrate a 20 MB open speedup. The hash and prefix changes have the largest observed reductions.

| 20 MB new-file first-readable | Before | After |
| --- | --- | --- |
| hash | 589.0 / 694.2 [485.3, 816.0] | 417.9 / 581.7 [353.3, 662.8] |
| shiki | 373.6 / 563.8 [327.3, 619.1] | 425.9 / 661.1 [325.1, 763.9] |
| readable | 354.2 / 517.1 [314.0, 529.4] | 319.2 / 483.0 [292.6, 494.8] |
| chunks | 401.8 / 593.1 [298.4, 781.9] | 157.8 / 216.6 [137.8, 272.3] |
| incremental | 158.1 / 276.6 [136.8, 304.5] | 183.1 / 313.2 [144.5, 603.2] |
| budget | 144.9 / 167.9 [131.8, 196.9] | 141.5 / 168.6 [128.9, 195.0] |
| deferred | 146.1 / 162.3 [132.0, 182.2] | 139.1 / 153.9 [128.5, 161.9] |

| Visible warm small document | Before | After |
| --- | --- | --- |
| hash | 15.4 / 28.6 [12.1, 40.9] | 15.4 / 24.2 [11.3, 24.4] |
| shiki | 14.6 / 23.3 [12.3, 24.9] | 14.6 / 22.4 [11.6, 24.4] |
| readable | 17.8 / 22.4 [10.5, 22.7] | 16.5 / 22.1 [10.8, 22.7] |
| chunks | 17.5 / 25.8 [8.4, 33.0] | 18.4 / 20.7 [12.3, 24.9] |
| incremental | 17.1 / 30.0 [12.1, 45.0] | 18.7 / 29.0 [12.1, 492.9] |
| budget | 14.8 / 20.8 [9.9, 23.3] | 14.7 / 21.6 [8.3, 30.9] |
| deferred | 12.6 / 21.0 [10.7, 22.0] | 18.5 / 23.0 [10.5, 26.9] |

| One-minute host load across run barriers | Before | After |
| --- | --- | --- |
| hash | 7.0 to 17.1 | 8.2 to 16.7 |
| shiki | 11.9 to 15.2 | 12.7 to 15.7 |
| readable | 9.7 to 11.3 | 9.7 to 12.6 |
| chunks | 12.0 to 22.7 | 18.1 to 24.5 |
| incremental | 17.2 to 30.2 | 14.9 to 26.5 |
| budget | 8.1 to 14.7 | 8.1 to 14.1 |
| deferred | 6.5 to 11.6 | 6.5 to 10.5 |

## Edit response measurement

Five alternating fresh Node workers per side ran 25 one-block edits of the 100k fixture. Both paths verified every result against full HTML. The full path returned all 26 blocks. The incremental response returned one changed block and retained order/ranges. Median serialized response size was 107614.0 bytes versus 7194.0 bytes. This is a response-size comparison, not total IPC traffic. Source requests remain full strings and worker requests also carry retained fingerprints.

Full render median 1.1 ms, range 0.9 to 2.3 ms. Incremental median 1.1 ms, range 1.0 to 2.8 ms. Worker-time improvement is not demonstrated. Full parsing dominates this small document.

## Full gate compared with M0

Full receipt: ../perf-FlUYrQ/receipt.json. Summary with raw latency samples and load: summary.json.

| Measure | M0 report | Final run |
| --- | --- | --- |
| Cold fresh p95 | 478.9 ms | 432.2 ms |
| Cold reused p95 | 430.0 ms | 411.6 ms |
| Visible normal p95 range | 22.8 to 24.3 ms | 18.8 to 27.5 ms |
| Hidden normal p95 range | 475.4 to 504.9 ms | 477.1 to 524.1 ms |
| New-file normal p95 range | 23.0 to 30.9 ms | 21.5 to 36.0 ms |
| 2 MB first-screen p95 | 53.9 ms | 35.5 ms |
| 20 MB first-screen p95 | 740.2 ms among 11 successful opens, 9 failures | 185.6 ms, 20/20 successful opens |
| Physical footprint median | 159.160 MB | 181.5 MB |
| Summed RSS median, diagnostic only | 433.193 MB | 483.2 MB |
| Failed opens | 9 of 960 | 0 of 960 |
| Typing | Old uncalibrated raw-latency gate failed | All 18 calibrated native/CDP cases pass |

These M0 rows are historical observations, not a matched A/B speedup. M1/M2 changed the app and the typing statistic. The final host load started at 10.2, 10.0, 11.3 and ended at 6.5, 8.5, 10.3 on 14 logical cores. This is the development Electron app with production bundles. No ASAR, installed-app or Windows runtime claim.

Physical footprint samples were 196.3, 181.5, 181.5, 181.6, 169.3 MB. The 200 MB gate passes. The 150 MB stretch misses. The increase from M0 is 22.380 MB and is not attributed to a specific change without a matched memory control.

The hidden-window gate remains open. In resident-hidden/math.md sample 4, relative to the external barrier, worker serialization ended at 6.73 ms, renderer-send was 23.32 ms, renderer-receive was 506.78 ms and first-readable was 506.83 ms. This trace places that sample's dominant delay after renderer-send. It does not establish a fix or one cause for every hidden-window tail.

## Oracle and regressions

Ten fixtures provide 400 checked states: ten initial states and 390 deterministic random insert/delete/replace edits. At each checked state, apply the delta to the retained blocks and compare HTML, author render trees, URL contexts, source ranges and MDX ranges/errors with a fresh render core. IDs are checked for uniqueness and stability separately, since their purpose differs from content identity. Fixtures cover reference definitions and images, footnotes, duplicate/numeric headings, nested lists/quotes, tables, open fences, setext headings, MDX with incomplete syntax, highlighted TypeScript, BOM, CRLF, bare CR and astral characters.

Separate tests compare streamed completion with a full render, check nested/MDX highlighting, stale streams, actual Node worker continuation and an intervening full render before stream completion. The full smoke suite verifies navigation, exports, containment, inert author HTML/MDX, editing, saves and byte preservation. The navigation/export smoke exposed the retained-baseline bug. The final request-fingerprint protocol and its regression test fix it. Large export smoke asserts a final sentinel beyond the prefix.

## Checks

- bun run build:native passed first, before implementation.
- bun run typecheck passed.
- bun run test passed, 230 tests, 0 failures.
- bun run test:corpus passed, 2 tests and 230 assertions. Corpus snapshots unchanged.
- bun run test:packaging passed, 14 tests.
- bun run build passed.
- SMD_BYTE_BLOG_DIR=<temporary copy> bun scripts/verify-smoke.ts from app passed 53/53 cases. All 15 blog MDX files were copied first. Originals were never used as test targets.
- bun run perf:gate completed, exit 1, with 960 successful opens and no correctness failures. Only the hidden-window latency gates fail. Tabs and two document panes remain n/a.
- git diff --check passed. Working tree clean before the measured run.

## Every final gate

Latency values are milliseconds. Memory is decimal MB. Typing p95 objects preserve the Event Timing bounds. The full receipt records calibrated excess over controls.

| Gate | Result | Samples | Median | p95 | Target |
| --- | --- | --- | --- | --- | --- |
| process-cold-fresh-profile | pass | 20 | 384.8 | 432.2 | 800 |
| process-cold-reused-profile | pass | 20 | 384.7 | 411.6 | 800 |
| resident-visible/small.md | pass | 20 | 13.4 | 21.9 | 150 |
| resident-visible/medium.md | pass | 20 | 20.8 | 22.4 | 150 |
| resident-visible/math.md | pass | 20 | 19.0 | 23.9 | 150 |
| resident-visible/diagrams.md | pass | 20 | 20.1 | 23.5 | 150 |
| resident-visible/fences.md | pass | 20 | 13.8 | 22.1 | 150 |
| resident-visible/long-lines.md | pass | 20 | 13.9 | 20.9 | 150 |
| resident-visible/unicode.md | pass | 20 | 15.0 | 22.5 | 150 |
| resident-visible/crlf.md | pass | 20 | 18.9 | 21.4 | 150 |
| resident-visible/mixed.md | pass | 20 | 13.5 | 18.8 | 150 |
| resident-visible/bom.md | pass | 20 | 14.3 | 22.0 | 150 |
| resident-visible/astro.mdx | pass | 20 | 20.6 | 27.5 | 150 |
| resident-hidden/small.md | fail | 20 | 22.0 | 481.0 | 150 |
| resident-hidden/medium.md | fail | 20 | 22.6 | 520.4 | 150 |
| resident-hidden/math.md | fail | 20 | 22.4 | 521.1 | 150 |
| resident-hidden/diagrams.md | fail | 20 | 22.6 | 508.9 | 150 |
| resident-hidden/fences.md | fail | 20 | 22.2 | 522.3 | 150 |
| resident-hidden/long-lines.md | fail | 20 | 21.3 | 514.8 | 150 |
| resident-hidden/unicode.md | fail | 20 | 22.0 | 524.1 | 150 |
| resident-hidden/crlf.md | fail | 20 | 22.0 | 523.2 | 150 |
| resident-hidden/mixed.md | fail | 20 | 22.1 | 477.1 | 150 |
| resident-hidden/bom.md | fail | 20 | 22.4 | 516.0 | 150 |
| resident-hidden/astro.mdx | fail | 20 | 23.5 | 503.1 | 150 |
| resident-new-file-miss/small.md | pass | 20 | 20.4 | 21.8 | 150 |
| resident-new-file-miss/medium.md | pass | 20 | 20.6 | 22.9 | 150 |
| resident-new-file-miss/math.md | pass | 20 | 21.6 | 34.8 | 150 |
| resident-new-file-miss/diagrams.md | pass | 20 | 22.2 | 36.0 | 150 |
| resident-new-file-miss/fences.md | pass | 20 | 16.7 | 22.1 | 150 |
| resident-new-file-miss/long-lines.md | pass | 20 | 12.9 | 22.4 | 150 |
| resident-new-file-miss/unicode.md | pass | 20 | 14.7 | 21.6 | 150 |
| resident-new-file-miss/crlf.md | pass | 20 | 14.4 | 21.8 | 150 |
| resident-new-file-miss/mixed.md | pass | 20 | 17.5 | 21.5 | 150 |
| resident-new-file-miss/bom.md | pass | 20 | 16.7 | 22.7 | 150 |
| resident-new-file-miss/astro.mdx | pass | 20 | 20.3 | 34.7 | 150 |
| A-to-B-to-A/small.md | pass | 20 | 21.0 | 25.6 | 150 |
| A-to-B-to-A/medium.md | pass | 20 | 15.5 | 22.8 | 150 |
| A-to-B-to-A/math.md | pass | 20 | 28.0 | 35.1 | 150 |
| A-to-B-to-A/diagrams.md | pass | 20 | 22.0 | 23.2 | 150 |
| A-to-B-to-A/fences.md | pass | 20 | 19.9 | 23.4 | 150 |
| A-to-B-to-A/long-lines.md | pass | 20 | 25.3 | 39.8 | 150 |
| A-to-B-to-A/unicode.md | pass | 20 | 18.8 | 22.7 | 150 |
| A-to-B-to-A/crlf.md | pass | 20 | 22.5 | 25.3 | 150 |
| A-to-B-to-A/mixed.md | pass | 20 | 21.4 | 23.8 | 150 |
| A-to-B-to-A/bom.md | pass | 20 | 21.8 | 30.2 | 150 |
| A-to-B-to-A/astro.mdx | pass | 20 | 21.5 | 27.3 | 150 |
| first-screen/small.md | pass | 20 | 20.4 | 21.8 | 200 |
| first-screen/medium.md | pass | 20 | 20.6 | 22.9 | 200 |
| first-screen/math.md | pass | 20 | 21.6 | 34.8 | 200 |
| first-screen/diagrams.md | pass | 20 | 22.2 | 36.0 | 200 |
| first-screen/fences.md | pass | 20 | 16.7 | 22.1 | 200 |
| first-screen/long-lines.md | pass | 20 | 12.9 | 22.4 | 200 |
| first-screen/unicode.md | pass | 20 | 14.7 | 21.6 | 200 |
| first-screen/crlf.md | pass | 20 | 14.4 | 21.8 | 200 |
| first-screen/mixed.md | pass | 20 | 17.5 | 21.5 | 200 |
| first-screen/bom.md | pass | 20 | 16.7 | 22.7 | 200 |
| first-screen/astro.mdx | pass | 20 | 20.3 | 34.7 | 200 |
| first-screen/huge.md | pass | 20 | 23.3 | 35.5 | 200 |
| first-screen/ceiling.md | pass | 20 | 153.1 | 185.6 | 200 |
| memory | pass | 5 | 181.5 | 196.3 | 200 |
| typing/native/live/top | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/native/live/middle | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/native/live/end | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/native/source/top | pass | 40 |  | {"lower":32,"upper":32,"upperExclusive":false} | 16.333290948023745 |
| typing/native/source/middle | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/native/source/end | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/native/split/top | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/native/split/middle | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/native/split/end | pass | 40 |  | {"lower":32,"upper":32,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/live/top | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/live/middle | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/live/end | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/source/top | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/source/middle | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/source/end | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/split/top | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/split/middle | pass | 40 |  | {"lower":32,"upper":32,"upperExclusive":false} | 16.333290948023745 |
| typing/cdp/split/end | pass | 40 |  | {"lower":24,"upper":24,"upperExclusive":false} | 16.333290948023745 |
| tab-switch-100k | n/a |  |  |  | 50 |
| typing-two-panes | n/a |  |  |  | 16 |
| correctness | pass |  |  |  |  |

# Window chrome polish

The seven visual changes are implemented and checkpointed. Functional checks pass. Performance qualification is incomplete: neither completed full run passed every gate.

The worktree is based on `m5-window` at `14ddca99d38f1cb69febe3811db8c94f80000bd6`. The latest measured revision is `3766ccb10467073de7127fd0d361c43d84f3eb58`. Both full performance receipts match every file in the current production bundle. The later capture-harness change adds TypeScript annotations only.

| Problem | Before | After |
| --- | --- | --- |
| 1. Editor measure | CodeMirror's base rule overrides the horizontal padding. Side by side has an unbounded measure. | All three editor modes have 24 px horizontal padding and a centered measure from Writing's content-width setting. Settings changes refresh CodeMirror geometry, including its caret. |
| 2. Tabs | Tabs grow from a fixed 180 px basis; the selected tab has an accent underline. | Tabs size to their content, bounded at 96 to 224 px on macOS and 100 to 240 px elsewhere. The selected tab has a neutral background. Close buttons appear on hover, keyboard focus and the active tab. Unsaved tabs show a dot. The strip remains below the existing title bar and disappears with one tab. |
| 3. Pane headers | Each pane repeats the filename and has a heavy focus underline. | One pane has no header. Two panes have compact mode controls and a 5 px system-accent focus dot. Pane names remain available to accessibility and through the header tooltip. A single document's filename appears in the window title. |
| 4. Mode controls | Long labels crowd narrow panes. | Live, Side and Source use compact segments with full tooltips and accessible labels. Panes at or below 360 px use a native select. Radio controls support arrow keys, Home and End. Existing View commands and shortcuts remain. |
| 5. Read header | The filename and Edit control duplicate other chrome. | A single reading pane has no header or Edit button. Word count and reading time appear in a quiet footer. The read surface has an Enter-to-edit tooltip. |
| 6. Settings | Plain selects and checkboxes; duplicate Appearance label. | Pop-up buttons, switches and number fields with units. The duplicate row is Color scheme. Groups are Appearance, Reading, Writing, Code, Behavior and Advanced. Settings follow the selected color scheme and preserve keyboard focus after saving. |
| 7. Motion | Springs, entry animations and checkbox pulses remain in CSS. | Decorative animations are removed. Chrome state changes are instant. Copy controls retain an 80 ms hover transition; the editor retains its normal caret blink. |

`main.ts`, document theme token files and dependencies are unchanged. Existing smoke selectors remain. Tab roles, selection state, visible focus and radiogroup semantics remain.

## Screenshots

All paths are relative to the repository root. Baselines were regenerated from an archived copy of the starting revision. Captures wait for a settled frame after theme and layout changes.

| Scene | Before | After |
| --- | --- | --- |
| One tab, Editorial Light, read | [.audit/design/before/one-tab-light-read.png](../../.audit/design/before/one-tab-light-read.png) | [.audit/design/after/one-tab-light-read.png](../../.audit/design/after/one-tab-light-read.png) |
| Two tabs and panes, light | [.audit/design/before/two-tabs-two-panes-light.png](../../.audit/design/before/two-tabs-two-panes-light.png) | [.audit/design/after/two-tabs-two-panes-light.png](../../.audit/design/after/two-tabs-two-panes-light.png) |
| Two tabs and panes, dark | [.audit/design/before/two-tabs-two-panes-dark.png](../../.audit/design/before/two-tabs-two-panes-dark.png) | [.audit/design/after/two-tabs-two-panes-dark.png](../../.audit/design/after/two-tabs-two-panes-dark.png) |
| 700 px, two panes | [.audit/design/before/narrow-700-two-panes.png](../../.audit/design/before/narrow-700-two-panes.png) | [.audit/design/after/narrow-700-two-panes.png](../../.audit/design/after/narrow-700-two-panes.png) |
| Settings, light | [.audit/design/before/settings-light.png](../../.audit/design/before/settings-light.png) | [.audit/design/after/settings-light.png](../../.audit/design/after/settings-light.png) |
| Settings, dark | [.audit/design/before/settings-dark.png](../../.audit/design/before/settings-dark.png) | [.audit/design/after/settings-dark.png](../../.audit/design/after/settings-dark.png) |

An additional [Source capture](../../.audit/design/after/one-tab-source.png) shows the centered 40-character writing measure and aligned caret. The visual driver is `app/scripts/verify-design.ts`.

## Checks

| Check | Result |
| --- | --- |
| `bun run build:native`, run first | PASS |
| `bun run typecheck` | PASS |
| Capture-harness standalone TypeScript check | PASS |
| `bun run test` | 275 pass, 1 skip, 0 fail |
| `bun run test:corpus` | 41 documents, 0 semantic edits |
| `bun run test:packaging` | 19 pass, 1 skip, 0 fail |
| `bun run build` | PASS |
| Full smoke suite | 68/68 pass, including 15 blog copies |
| Design driver | PASS, including native radio-key navigation, narrow controls, one-pane layout, width changes and caret alignment |
| Full `bun run perf:gate` | FAIL on both completed runs |

The packaged-bundle signing check is the expected packaging skip. This pass does not qualify an installed package or Windows hardware. Blog input was copied to a temporary directory before running `SMD_BYTE_BLOG_DIR=<copy> bun scripts/verify-smoke.ts` from `app/`. Original blog files were never smoke inputs. Logs are in `.audit/design/`.

The caret regression fails on archived revision `ac315ff` and passes with the geometry refresh. Three repeated visual runs passed. The design detector flags existing document alert borders and the intentionally compact chrome; those do not require changes to document styles.

## Performance

| Gate or evidence | First full run | Second full run |
| --- | --- | --- |
| Gates passed | 98/100 | 97/100 |
| Successful opens | 960; zero failed samples | 960; zero failed samples |
| Tab switching, p95; target below 50 ms | 24.5 ms, PASS | 67.5 ms, FAIL |
| 20 MB first screen, p95; target below 200 ms | 170.9 ms, PASS | 258.9 ms, FAIL |
| Typing | All 36 cases pass | All 36 cases pass |
| One-document memory; target below 200 MB | Unsettled, FAIL | 142.4 MB median, PASS |
| Five-tab memory stability | Unsettled, FAIL | Unsettled, FAIL |

Each typing case uses 40 trusted keys, a matched textarea control and the unchanged frame-plus-8-ms allowance. Every full run verified saved bytes and recorded zero correctness failures.

The first run's GPU footprint changed by 12.2 MB during the final five one-document observations and by 3.9 MB in the five-tab observations. A competing SimpleMD performance run was active. A separate memory diagnostic passed one-document memory at 138.6 MB but failed five-tab stability. The second full run began after that competing run exited; it still failed three gates. Host load changed during both runs. These observations do not establish a causal regression or a speedup. They also do not satisfy the requested all-gates pass.

The memory collector, settling rule, sample counts and thresholds are unchanged. No forced garbage collection or selection of low samples was used.

Receipts:

- [First full run](../../.audit/perf-JpKm8I/receipt.json)
- [Memory diagnostic](../../.audit/perf-jN2r95/receipt.json)
- [Second full run](../../.audit/perf-X98kAg/receipt.json)
- [Caret failure before the fix](../../.audit/design/caret-control.log)

A quiet qualification window is needed before another full run. No push or pull request was made.

Branch t3/fbfe4f7b, head 3766ccb10467073de7127fd0d361c43d84f3eb58, checks FAIL: performance qualification remains open.

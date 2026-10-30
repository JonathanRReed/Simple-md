# GPU memory investigation

Final report, 2026-10-29. The research ran on `research/gpu-memory` from `m6-workflow`. Its raw receipts are kept locally in `.audit/gpu-memory/` (git-ignored). One fix ships. The memory gate is unchanged.

## Idle caret

CodeMirror's focused cursor runs an infinite CSS blink on the compositor. In a ten-second idle trace, the renderer ran zero JavaScript animation frames and zero DOM mutations, but Chromium logged 1,203 display-link callbacks.

The editor CSS now stops the blink after four cycles (about 4.8 seconds), with the cursor left visible. A selection change or refocus restarts it. The initial animation gets its own name, so CodeMirror's first selection change still restarts a completed blink. A GUI check confirmed that no animation was running 7.5 seconds after launch with the editor focused, and that one was running after the cursor moved.

Tray energy did not change measurably. Over five alternating 60-second pairs, median CPU was 0.32% of one core before and 0.29% after, and interrupt wakeups were 7.5 per second before and 7.0 after. The ranges overlap. Hidden windows already ran no frames.

No other idle work was found: no app-owned animation-frame loop or repeating timer. Viewport updates, diagram observers, highlights, autosave and export timers are all one-shot or event-driven.

## GPU footprint swings

The memory gate's occasional failures come from the GPU process. Its physical footprint jumps from about 41 MB to about 278 MB, which takes the app total from about 140 MB to about 380 MB. Controls on an M4 Pro (ANGLE Metal, Graphite Dawn) showed:

| Window state | GPU footprint range | Settled total under the current rule |
| --- | --- | --- |
| Hidden in the tray, with or without external GPU load | 39 to 45 MB | 135 to 139 MB |
| Covered by another window | 41 to 278 MB | 141 to 147 MB, or no stable window in 1 of 4 runs |

- The swing happens only while the window is covered.
- Removing vibrancy did not change it (278 MB peak either way).
- Heavy external GPU work did not cause it in hidden windows, and did not enlarge it in covered ones.
- OS snapshots attribute the change to IOSurface, IOAccelerator and unmapped graphics memory. About 100 MB of it was reclaimable in the high snapshot. Malloc stayed small.

So the swing is Chromium and macOS compositor memory for an occluded window, not app allocations. It is reclaimable and does not grow. These were controls on a contended host, so they do not rule out every external cause.

## Gate decision

The memory gate is unchanged: a stable five-sample window ending in the last five observations, the final process set, at most 2 MB per-process span, and max(median, final) under 200 MB. Every observation stays in the receipt.

There is no case for exempting GPU memory. A run where the window is covered can fail the rule when no stable window forms. The harness should therefore keep the measured window visible and uncovered during memory sampling, as it already intends. Any change to the gate's definition needs the owner's approval.

Not done: display-scale and window-size controls, clean visible energy pairs, and three full performance receipts on a quiet machine. All of them open windows. They wait for an owner-approved quiet run.

# Tab design

SimpleMD keeps tabs in the window frame and the document in its own surface. All CSS and TypeScript are original. No Helium code, assets, icons or text were copied. Helium is GPL-3.0; SimpleMD remains MIT.

## Study and measurements

Read the [Helium UI patches](https://github.com/imputnet/helium/tree/main/patches/helium/ui) through GitHub's contents API on 2026-10-29. Reviewed the horizontal and single-tab screenshots on [Helium's site](https://helium.computer/), `landing/interface/dynamic-tabs.avif` and `dynamic-one.avif`.

| Reference | Observed design | SimpleMD choice |
| --- | --- | --- |
| `layout-constants.patch` | 3 px base padding, 28 px toolbar controls, 31 px tabs plus 3 px strip padding | 3 px grid, 28 px tab rows, 34 px titlebar, 6 px gaps and 9 px label insets |
| `layout/horizontal-tabs.patch` | Layout controls which buttons and trailing separators appear | No tab separators; soft rounded active fill, faint hover fill, plain inactive text |
| `layout/vertical.patch` | Rounded rows, shared frame space, 5 px resize area | Same rows in both orientations; 180 px sidebar clamped to 140 through 420 px; transparent 6 px resize target with a 2 px hover or focus line |
| `layout/compact.patch` | Less redundant top chrome | Horizontal tabs and trailing view controls share the titlebar; macOS reserves 84 px for traffic lights at x=12, y=10; caption overlays remain native elsewhere |
| `layout/frame-grab-handle.patch` | 27 px grab space in classic layout | At least 27 px trailing drag space, even with overflowing tabs |
| `native-frame-materials.patch` | Native material shared across frame and sidebar | Existing macOS vibrancy and neutral translucent chrome; opaque Windows and Linux frame |
| `frame-radius-helper.patch` | 12 px older macOS corners, 17 px on macOS 26, 3 px inner inset | 9 px inner radius on macOS, 6 px elsewhere, without private APIs |
| `fix-layout-separators.patch` | Separators respond to attached chrome | Remove ornamental rules; retain the split-pane boundary |
| `layout/zen-mode.patch` | 6 px reveal edge, 200 ms reveal | 6 px edge with subtle chrome reveal; instant with Reduce Motion or motion off |

The `ui/enable-tab-hover-cards.patch` path returned 404. Read [the patch under core](https://github.com/imputnet/helium/blob/main/patches/helium/core/enable-tab-hover-cards.patch). It enables preview images. SimpleMD keeps text tooltips with full paths and does not render dormant documents for previews. Some reference screenshots have tab separators; omitting them is a SimpleMD choice.

## Behavior

Labels use 12 px system text at line height 1.5. `splitTabLabel` retains the last seven characters. Ordinary horizontal tabs size to their labels with consistent padding, cap at 225 px and scroll within faded edges. Dirty dots and close buttons share one 18 px slot, exchanging on hover or focus without moving the label.

The active pane owns one trailing toolbar in the top chrome row. Its 28 px buttons use original 17 px outline SVGs, 1.5 px strokes and 7 px corners. Read, Live, Side by side and Source form a segmented icon group, followed by a separator and side-by-side, stacked and sidebar layout toggles. Modes use book, pen, text-column and code glyphs; window splits use separate window frames. Aa stays available in every mode so switching modes keeps the controls in place. Escape and outside clicks dismiss Aa and return focus to its button. Pressed controls use a soft system-accent fill; every button has an accessible name and shortcut tooltip. Tabs reserve trailing drag space before the controls. Narrow windows hide the sidebar toggle and reading options; View commands and shortcuts remain available.

A 28 px search button precedes horizontal tabs. The sidebar has a search field below the traffic lights. Both open Open Quickly; typing in the sidebar carries the query into its picker. Search controls hide in zen mode and when the sidebar collapses. The sidebar extends to the top of the window; its titlebar filename stays hidden while the sidebar is open. Collapsing the sidebar restores the titlebar filename. Pane filenames appear only in split panes.

Pins come first. Horizontal pins are 62 px wide with a short unique filename fragment. Shared long prefixes use numbered fragments. Pins stay outside the ordinary tab scroller. Wheel and trackpad input scroll ordinary tabs, edge fades show overflow, and selection or resizing keeps the active tab visible. Sidebar pins retain full labels, with 9 px extra space before ordinary tabs. Tooltips retain full paths; accessible names include the full label and "pinned". Pins have no close button. Normal close switches away, opening an untitled document if the pin is alone. Menus and the command list offer Unpin and Close Pinned Tab. Dragging reorders or changes sections; the top drop space creates the first pin. Number shortcuts count pins first.

Pinned paths and order live in app state, `settings.json`, never user config. Launch restores existing regular files only. Closing a window retains pins. Explicit close forgets the pin only after accepting the close. Save As moves its path; document links open another tab instead of replacing a pin.

View > Zen Mode uses Command-Shift-J or Control-Shift-J. Zen is a session toggle and resets on relaunch. The retired `zen-mode` config key is ignored. Escape exits after dismissing any open popover or Find bar. A brief entry hint shows the exit shortcut. Zen hides tabs, toolbar and footer. Hovering the top edge or focusing controls reveals chrome without moving the document. Native window titles and represented filenames remain accessible. macOS traffic lights follow reveal; Windows and Linux retain native caption controls.

All eight document themes keep neutral chrome and system-accent focus. Increased contrast and forced colors add selection outlines. No fonts or assets were added. Selection scrolling is deferred. Read mode reuses an already-mounted, unchanged document so revisits do not restart lazy diagrams. First-readable markers keep their existing meaning. Performance qualification requires a receipt from the full gate.

## Chrome motion

The owner revised the motion decision on 2026-10-30. `ui-motion = subtle | off` defaults to `subtle` and generates a Settings switch. Reduce Motion overrides the setting. Motion starts only after a document has painted. Document text, reading position and first paint never animate.

CSS owns 120, 160 and 200 ms tokens, a 100 ms exit token, ease-out `cubic-bezier(0.2, 0, 0, 1)` and gentle spring `cubic-bezier(0.3, 0.7, 0.2, 1)`. Transforms and opacity run on the compositor. Nothing keeps `will-change` set.

Both tab layouts use FLIP for insertions, removals, reordering and pin moves. New rows fade and expand from a 0.96 scale while neighboring rows slide to their new positions. Removed rows collapse as inert chrome copies while surviving rows slide into place. One active pill moves between the retained tab nodes. Dirty dots and close buttons crossfade in their shared slot.

Sidebar toggles and split bounds use 200 ms FLIP. Existing document viewports keep fixed dimensions, counteract the frame scale and clip during the transition. They reflow once when motion ends. Pointer resizing stays immediate. Read, Live, Side and Source change their chrome indicator without fading the document. Buttons have a 120 ms pressed transition. The outline magnification uses the 160 ms token.

The palette, Open Quickly and reading options fade and scale from 0.98 over 120 ms, then leave over 100 ms. Exits use inert chrome copies so closing a panel restores focus and removes its interaction immediately. Zen reveals chrome with a 4 px slide and fade. Disabling motion cancels running animations and commits final layout.

The active filename or tab carries a secondary-text Edited label. Split headers keep it beside their filename. The sidebar search placeholder uses opaque secondary text in both appearances.

## Smoke cases

The smoke script adds `tab-design-titlebar-grab-regions`, `tab-design-zen-native-toggle` and `tabs-pinned-relaunch`. These check drag-region assignments, native traffic-light coordinates, native document identity, zen menu and shortcut behavior, and restoring only existing pins in order.

The GUI run must also physically drag empty titlebar space and the trailing grab area with overflowing tabs. Confirm tabs remain clickable, macOS traffic lights sit above the sidebar and avoid labels, Windows caption buttons avoid tabs, and zen reveals usable native controls. CSS drag-region assertions do not prove OS dragging.

## Incoming changes and first saves

The conflict banner offers View incoming changes alongside Reload, Keep mine and Save mine as. The comparison shows local and incoming disk text in read-only columns with synchronized scrolling. Closing it leaves the conflict unresolved. New disk notifications close the old comparison so it cannot present stale incoming text.

A file opened in Read waits for a deliberate edit before its first autosave. Twelve changed characters, a second edit burst after at least 1.5 seconds, or an explicit Save releases the guard. Tiny edits remain marked Edited, survive tab switches and get the standard save prompt on close. Files opened for editing retain normal autosave. This avoids adding a toast to every first save and also covers closing before the autosave timer runs.

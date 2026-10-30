# Tab design

SimpleMD keeps tabs in the window frame and the document in its own surface. All CSS and TypeScript are original. No Helium code, assets, icons or text were copied. Helium is GPL-3.0; SimpleMD remains MIT.

## Study and measurements

Read the [Helium UI patches](https://github.com/imputnet/helium/tree/main/patches/helium/ui) through GitHub's contents API on 2026-10-29. Reviewed the horizontal and single-tab screenshots on [Helium's site](https://helium.computer/), `landing/interface/dynamic-tabs.avif` and `dynamic-one.avif`.

| Reference | Observed design | SimpleMD choice |
| --- | --- | --- |
| `layout-constants.patch` | 3 px base padding, 28 px toolbar controls, 31 px tabs plus 3 px strip padding | 3 px grid, 28 px tab rows, 34 px titlebar, 6 px gaps and 9 px label insets |
| `layout/horizontal-tabs.patch` | Layout controls which buttons and trailing separators appear | No tab separators; soft rounded active fill, faint hover fill, plain inactive text |
| `layout/vertical.patch` | Rounded rows, shared frame space, 5 px resize area | Same rows in both orientations; 220 px sidebar clamped to 160–420 px; transparent 6 px resize target with a 2 px hover or focus line |
| `layout/compact.patch` | Less redundant top chrome | Horizontal tabs share the titlebar; macOS reserves 84 px for traffic lights at x=12, y=10; caption overlays remain native elsewhere |
| `layout/frame-grab-handle.patch` | 27 px grab space in classic layout | At least 27 px trailing drag space, even with overflowing tabs |
| `native-frame-materials.patch` | Native material shared across frame and sidebar | Existing macOS vibrancy and neutral translucent chrome; opaque Windows and Linux frame |
| `frame-radius-helper.patch` | 12 px older macOS corners, 17 px on macOS 26, 3 px inner inset | 9 px inner radius on macOS, 6 px elsewhere, without private APIs |
| `fix-layout-separators.patch` | Separators respond to attached chrome | Remove ornamental rules; retain the split-pane boundary |
| `layout/zen-mode.patch` | 6 px reveal edge, 200 ms reveal | 6 px edge with instant reveal and collapse, including reduced motion |

The requested `ui/enable-tab-hover-cards.patch` returned 404. Read [the patch under core](https://github.com/imputnet/helium/blob/main/patches/helium/core/enable-tab-hover-cards.patch). It enables preview images. SimpleMD keeps text tooltips with full paths and does not render dormant documents for previews. Some reference screenshots have tab separators; omitting them is a SimpleMD choice.

## Behavior

Labels use 12 px system text at line height 1.5. `splitTabLabel` retains the last seven characters. Ordinary horizontal tabs keep at least 108 px and scroll within faded edges. Dirty dots and close buttons share one 18 px slot, exchanging on hover or focus without moving the label.

Pins come first. Horizontal pins are 42 px wide with two filename characters. Sidebar pins retain full labels, with 9 px extra space before ordinary tabs. Tooltips retain full paths; accessible names include the full label and "pinned". Pins have no close button. Normal close switches away, opening an untitled document if the pin is alone. Menus and the command list offer Unpin and Close Pinned Tab. Dragging reorders or changes sections; the top drop space creates the first pin. Number shortcuts count pins first.

Pinned paths and order live in app state, `settings.json`, never user config. Launch restores existing regular files only. Closing a window retains pins. Explicit close forgets the pin only after accepting the close. Save As moves its path; document links open another tab instead of replacing a pin.

View > Zen Mode uses Command-Shift-J or Control-Shift-J. `zen-mode = false` is the config default. Zen hides tabs, toolbar and footer. Hovering the top edge or focusing controls reveals chrome without moving the document. Native window titles and represented filenames remain accessible. macOS traffic lights follow reveal; Windows and Linux retain native caption controls.

All eight document themes keep neutral chrome and system-accent focus. Increased contrast and forced colors add selection outlines. No fonts, assets or animation were added. Selection scrolling is deferred; document rendering and first-readable markers are unchanged. Performance remains unqualified until its gate runs.

## Smoke cases added, not run

The smoke script adds `tab-design-titlebar-grab-regions`, `tab-design-zen-native-toggle` and `tabs-pinned-relaunch`. These check drag-region assignments, native traffic-light coordinates, native document identity, zen menu and shortcut behavior, and restoring only existing pins in order.

The GUI run must also physically drag empty titlebar space and the trailing grab area with overflowing tabs. Confirm tabs remain clickable, macOS traffic lights sit above the sidebar and avoid labels, Windows caption buttons avoid tabs, and zen reveals usable native controls. CSS drag-region assertions do not prove OS dragging.

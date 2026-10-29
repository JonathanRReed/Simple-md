# Verification receipt

- Subject: Packaged source f4cabca01e0f143c5b5334b1bf045636d9420c63 in /Users/jonathanreed/.t3/worktrees/Simple-md/t3-41c64cc3; ad-hoc and Developer ID artifacts identified in artifact-adhoc.json and artifact-developer-id.json.
- Acceptance target: The packaged extensions preview and thumbnail the named Markdown and MDX fixtures while SimpleMD is closed, leave .txt with the system, and restore registration state.
- Checked at: 2026-10-29T07:56:17Z
- Required layers: Source, Static checks, Full relevant suite, Package, Runtime, Rendered UI, Thumbnail routing, Cleanup

| Layer | Required claim | Exact receipt | Status |
| --- | --- | --- | --- |
| Source | The real browser renderer is embedded once per process with bounded reads and sandbox-only entitlements. | source-final.json; source-unchanged.txt; build-extensions.sh and PreviewProvider.swift inspection. | Verified |
| Static checks | Current source passes typecheck. | bun run typecheck, typecheck-mdx.txt, exit 0. | Verified |
| Full relevant suite | Required tests and builds pass. | build-native-resume.txt; test-final.txt; test-corpus-final.txt; test-packaging-final.txt; build-final.txt. | Verified |
| Package | Both modes have valid signatures, exact layout, correct types, universal extensions, and App Sandbox only. | pack-adhoc-final.txt; pack-developer-id.txt; packaging-adhoc-final.txt and packaging-developer-id.txt, each 18 pass and 0 fail; both run directories' signatures.txt. | Verified |
| Runtime | Each supported fixture reaches the real preview, .txt is unclaimed, caps and image access behave as specified, and the main app is closed. | run-adhoc-final/runtime.txt and main-app-closed.txt; run-developer-id/runtime.txt and main-app-closed.txt; preview-adhoc-final.txt and preview-developer-id.txt. | Verified |
| Rendered UI | Both modes display all requested content safely. | All 22 panel-only PNGs under run-adhoc-final/panels and run-developer-id/panels were inspected; REPORT.md fixture table. | Verified |
| Thumbnail routing | SimpleMD supplies Markdown and MDX thumbnails. | Both final timing tables have simplemd_thumbnail=false for all supported fixtures. Apple's TextExtension appears in runtime logs. Both e2e commands exit 1 for missing MDX attribution. | Failed |
| Cleanup | Test registrations, copies, containers, scratch paths, and processes are gone; FluxMarkdown is restored. | cleanup-final.json passed=true; all five FluxMarkdown before/after pairs match; flux-final.txt has default election. | Verified |

Explicit exclusions: Full perf:gate, Xcode or system installs, notarization, push, pull request. Physical Finder Space-key acceptance, Intel execution, clean-machine qualification, and independent security review were not performed.

Remaining risk: Thumbnail routing is unresolved. Milestone 4 is not qualified. The preserved JSC comparison is inconclusive for speed, and the rich 4 MB fixture takes several seconds.

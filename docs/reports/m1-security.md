# Milestone 1 security fixes

Runtime source: `a09a1f4f6334f08fba3ae8e435e82249fde819f1`. Baseline: `a38994f4acb792907ea5a0a1870ec03946b69aac`. Both are local revisions. No push or pull request.

## Findings and regression evidence

1. Local file reach. The shared resolver bounds minted file URLs to the detected root, or the document folder without a root. A leading slash without a root resolves inside that folder. Rejected Markdown images retain their image element without a source, and links lose their href. The opener checks both URL containment and realpath containment, requires a supported text-document extension, and keeps the original path when opening it. Export checks real paths, regular-file type and a 25 MB image cap. Missing, unsupported or refused images log a warning and retain their URL in the embedding result. The final HTML drops failed local sources, local links and local srcset attributes. This avoids exposing absolute paths or creating links that break when an export moves. A symlinked Astro public directory cannot grant an outside root. Existing disk renders are invalidated by the cache-version change.

   Regression tests cover climbing paths, encoded climbing, sibling-prefix paths, a leading slash without a root, symlink escapes, missing and TIFF images, byte caps, local srcset export, outside file-link requests and the Astro-root bypass. The original containment/export tests failed before the fixes. The Electron export test also caught print preparation aborting on a missing image. It now passes with warnings and no local file URLs in the exported attributes. The separate Astro-root test failed before its fix.

2. FIFO and device hangs. Document reads open with `O_RDONLY | O_NONBLOCK`, fstat the handle, require a regular file, enforce a 64 MB limit and read from that same handle with bounded chunks. `readDocument`, `readDiskText` and prewarm use this path. Export images use it with the 25 MB limit. Tests use a real FIFO, a symlink to `/dev/zero` and a directory named `x.md`, then verify a regular document still reads. All three failed before the fix and pass now. A FIFO-image test also verifies that another image still embeds.

3. Locked files. The macOS write-access check detects immutable targets and opens them read-only. Saves reject them before creating a temporary file. The helper copies ACLs and xattrs without `COPYFILE_STAT`, and chmod restores mode separately. Cleanup ignores removal failures so the original error survives. The `chflags uchg` regression failed before the fix and now passes. A separate test verifies that metadata copying does not lock the temporary file. Both tests clear flags in teardown. Existing xattr, Finder-tag, ACL, permission and repeated-save tests pass.

4. Quadratic MDX. The inline rule exits unless the current character is `@`, slices through `END@` and performs one Map lookup. App-owned token nodes use a WeakMap instead of repeated subtree validation. Worker replies validate trees once with an iterative validator that rejects cycles. Live and Source edits request parser ranges only. Read and Side by side request full renders. Beyond 128 nested JSX elements, the preview shows escaped source with a visible marker instead of dropping it. The original 5,000-level content-retention and tree-validation regressions failed and now pass. Worker tests verify range-only replies and all 20,000 expressions within the default 30-second deadline. Electron smoke confirms that Source and Live edits do not request full renders.

5. Save documentation. The README now says that metadata-copy failures log an error and the save proceeds, and that metadata uses one short-lived process per save. The documentation regression failed before the update and passes now.

Tests are in `app/test/security-regressions.test.ts`, `app/test/security-docs.test.ts`, `app/test/render-worker.test.ts`, and the security cases in `app/scripts/verify-smoke.ts`.

## Removed code and hardening

- Removed the browser render-core bundle from the production build and explicitly excluded `dist/render-core.js` from packaging. The Node-free core test still builds it in memory. The packaging regression creates an ASAR using electron-builder's configured file filter, including a stale browser-bundle fixture, and proves that the worker is present and the browser bundle is absent. This is an archive/filter check, not a packaged-install qualification.
- Removed the persistent metadata process, pending request map, idle timer and metadata JSON-lines protocol. Each save calls `simplemd-peek --copy-metadata <src> <dst>` once with a five-second timeout. Failure remains non-fatal.
- Cached project-root lookup per folder for two seconds, with explicit invalidation on document open. A cache-reuse and invalidation regression passes.
- Blocked print-window navigation and new windows. Added `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` and `frame-src 'none'`. Removed explicit `file:` from media-src. img-src retains it for local images.

The render-core diff is confined to the MDX rule, app-owned node storage, serialization and tree-validation calls. Markdown parser options, heading slugs, emoji, math, pictures and footnotes are untouched.

## Benchmarks

Times are milliseconds, shown as median [minimum, maximum], over five alternating before/after pairs. The expression fixtures are 168,888 and 688,888 bytes, matching the requested 169 KB and 689 KB cases. Each fixture gets a fresh Node worker, warmed before timing. Timing covers rendering, worker serialization, IPC and reply validation. Every expression count is checked. The nested fixture checks its deepest text.

| Fixture | Bytes | Before, ms | After, ms |
| --- | ---: | ---: | ---: |
| 5,000 expression paragraphs | 168,888 | 873.30 [772.01, 888.48] | 260.70 [229.91, 521.65] |
| 20,000 expression paragraphs | 688,888 | 11,060.26 [10,184.01, 11,873.31] | 914.20 [829.92, 976.05] |
| 5,000 nested `<b>` elements | 35,017 | 2,684.70 [2,525.22, 3,076.06] | 104.10 [94.48, 118.40] |

The baseline lost the deepest text in all five nested runs. The corrected version retained it in all five, using the escaped-source fallback. Its time therefore measures changed behavior, not an equivalent-output speedup. Both paragraph cases retained every expression on both sides. No request timed out or returned an error.

A separate CPU profile placed the baseline's hottest worker frame in the MDX inline Map loop. The nested baseline also spent time repeatedly reading ancestor directories. The host had other workloads running on 14 logical CPUs. Initial load average was 16.85 and later 8.30. These are local worker measurements, not release latency or memory qualification. Raw samples and worker hashes are in [m1-security-benchmarks.json](m1-security-benchmarks.json). Reproduce with `bun scripts/bench-mdx-security.ts <output-directory>` from app, then run the emitted `bench.mjs` with Node.

## Checks

- `bun run build:native`: passed first, then rebuilt after the native changes.
- `bun run typecheck`: passed.
- `bun run test`: 211 passed, zero failed.
- `bun run test:packaging`: 14 passed, zero failed.
- `bun run check:rust`: passed.
- `bun run test:rust`: 16 tests passed across both binaries.
- `cargo fmt --manifest-path native/Cargo.toml --check`: passed.
- `bun run build`: passed. `dist/render-core.js` is absent.
- Individual smoke cases `render-links-pdf`, `author-html`, `mdx-editing`, `mdx-invalid-recovery`, `bytes-metadata` and `edit-modes-undo-save`: passed.
- Full smoke with `SMD_BYTE_BLOG_DIR` pointing only to a temporary copy: 51 of 51 passed on the final runtime source. All 15 blog cases passed. SHA-256 checks confirmed that the original files and the temporary input copies kept their original bytes.
- Full `perf:gate`: not run, as requested.

Local failure and success logs are retained in `.audit/m1-security/`. Final full-smoke artifacts are in `/var/folders/ph/7cfrg6mn3bj120hdsfs79d140000gn/T/simple-md-smoke-E7Wp86`.

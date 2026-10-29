# M2 GitHub fidelity report

Implemented on `t3/3eca45e9`, based on `m1-integration` at `a38994f4acb792907ea5a0a1870ec03946b69aac`. The verified source checkpoint is `d9d5bfd423f33bb8c570c126ca8a4bc50eec34eb`. The following commit adds this report and its timing receipt only.

All 41 pinned documents pass `bun run test:corpus` with zero unexplained semantic edits. No reference source, HTML, receipt or license snapshot changed. There are no new feature exceptions.

## Implementation

| Feature | Approach and evidence |
| --- | --- |
| Typed punctuation | `typographer: false` was already present in M1. A focused check preserves straight quotes, repeated dashes and dots. |
| GFM autolinks | Replace fuzzy domain linking with GFM URL and email recognition. Handle `www.`, HTTP/HTTPS, extended email local/domain characters, punctuation and balanced parentheses. Keep code and existing anchors literal. All destinations still pass the URL resolver. |
| Strikethrough | Reuse markdown-it delimiter pairing with separate markers for single and double tildes. Mismatched lengths and runs longer than two remain literal. |
| Tables | Keep markdown-it's table parser, alignment, escaped-pipe handling, missing-cell padding and extra-cell removal. Restore authored Unicode spaces at cell boundaries before inline parsing. Tests also cover mismatched headers and nested tables. |
| Heading IDs | Pin `github-slugger` and feed it parsed text, excluding image alt text and HTML tags. After sanitization, include raw HTML headings in document order and rebuild IDs after block reuse. Keep explicit author IDs under the existing sanitizer policy. Tests cover Unicode, duplicate suffix collisions and mixed Markdown/HTML headings. |
| Emoji | Use the pinned `gemoji` Unicode alias map. Unknown and custom image shortcodes stay text. Code stays literal. On 2026-10-28, all 1,913 aliases matched the 1,870 Unicode entries in GitHub's upstream database. |
| Math | Add GitHub parsing for `$...$`, `$$...$$`, math fences and dollar/backtick spans. Inline math follows Markdown parsing, so escaped punctuation, code and Markdown delimiter boundaries match the reference. Display math preserves matrix line breaks and GitHub's indentation handling. KaTeX keeps `trust: false`, bounded expansion and a fresh macro table per equation. |
| Pictures and theme fragments | Preserve sanitized picture sources and media queries. The app already sets Electron's `nativeTheme.themeSource` from its theme setting, so picture media follow the app theme. Add CSS for the two GitHub image fragments. A running-app test switches light, dark and light again and checks the loaded SVG source, decoded dimensions and fragment visibility. |
| Reference images and links | Keep resolution after full-document reference parsing. Existing cache checks verify that changing a definition updates targets and block keys. Add coverage for reference links with encoded heading fragments and reference images with theme fragments. |
| Footnotes | Keep first-reference numbering from the existing plugin. Generate GitHub-style reference IDs, repeated-reference suffixes, backrefs, labels and the accessible Footnotes heading. DOM checks follow every generated reference and backlink. |
| Cross-file fragments | Keep the fragment in the resolver's local-file URL. After navigation finishes, scroll to the mapped target. Read and split views use the document fragment map; source and live modes use the matching render block's source range. The app smoke opens an encoded sibling filename and verifies that its heading reaches the viewport start. |
| Other corpus differences | Render YAML frontmatter as inert metadata tables, with escaped values, bounded nesting and aliases disabled. Match task checkbox accessibility, alert title casing, multiline image alt text and standalone HTML image paragraphs. Resolve GitHub image blob URLs to raw resources. |
| CI | Run `test:corpus` wherever normal tests run in `desktop.yml`, with `xvfb-run -a` on Linux. The existing Windows preview spike job remains in CI. |

Author HTML still uses `sanitizeAuthorHtml()`. The sanitizer policy, `main.ts` and `preload.ts` are unchanged. The only resolver change converts GitHub blob image URLs to raw resource URLs after the existing scheme and remote-image checks.

## Corpus counts

The fresh M1 baseline was 381 edits, rather than the brief's estimate of about 587. These are DOM edit operations, not independent bugs or feature counts. Every after count is zero.

| Category | Before | After |
| --- | ---: | ---: |
| grammar | 119 | 0 |
| text | 23 | 0 |
| sanitization | 19 | 0 |
| URL resolution | 112 | 0 |
| headings | 30 | 0 |
| footnotes | 1 | 0 |
| math | 18 | 0 |
| Mermaid | 0 | 0 |
| alerts | 0 | 0 |
| tables | 11 | 0 |
| accessibility | 23 | 0 |
| enrichment | 25 | 0 |
| Total unexplained | 381 | 0 |

## Normalization and test setup

[README.md](README.md#named-normalizations) documents every change:

- N04a removes GitHub's `secured-asset-link` delivery marker.
- N09a decodes the extra HTML-entity layer in GitHub's math transport. The decoded TeX, mode and render presence still compare.
- N05 applies the existing empty-ID rule after prefix removal. N08 applies the existing block-boundary whitespace rule to normalized code blocks.
- N06 recognizes the pinned Prisma redirect, legacy attachment URL identities and GitHub directory URL canonicalization. Queries and fragments remain significant.

Positive and negative controls cover these rules, including changed math symbols, picture queries, Unicode table spaces and attachment queries/fragments. The test now creates temporary repository roots with `.git` markers, so root-relative paths exercise the production resolver. Previously, the synthetic paths had no repository root and resolved against github.com in the normalizer.

No normalization hides parser differences, missing structures, changed targets or render failures. The only declared exceptions remain GeoJSON, TopoJSON and STL code fallbacks, plus custom image emoji as text. Math and Mermaid retain their existing source-and-success comparison. No reference refresh ran.

## Dependencies

All additions are exact pins and MIT licensed:

- `github-slugger@2.0.0` supplies the required Unicode and duplicate-ID rules without maintaining a separate regex table.
- `gemoji@8.1.0` supplies GitHub's Unicode aliases. It adds no image requests or runtime network access.
- `yaml@2.8.1` parses frontmatter into data for escaped tables. It avoids a partial handwritten YAML parser. Alias expansion is disabled; invalid or excessive nesting falls back to escaped source.

Remove `@mdit/plugin-katex` and its unused TeX plugin dependency. Keep the existing KaTeX renderer. The browser-core test still renders without Node imports or a DOM.

## Medium-worker timing

[m2-worker-medium.json](m2-worker-medium.json) contains every sample and the revision IDs. The unchanged 90,000-byte fixture produces 24 blocks. Each side has five alternating fresh-worker samples, with one first render, 20 warmups and 50 measured warm renders per sample. Every render completed and retained stable block keys. The timed region excludes module loading and worker initialization.

| Measurement | M1 median | M2 median | M1 range | M2 range |
| --- | ---: | ---: | ---: | ---: |
| First render inside worker | 8.960 ms | 7.625 ms | 8.677 to 9.240 ms | 7.239 to 8.073 ms |
| Mean warm render per sample | 1.150 ms | 1.022 ms | 1.128 to 1.168 ms | 1.000 to 1.064 ms |

This fixture shows no regression. Separate CPU profiles of 1,500 renders per side show Markdown tokenization and cache-key hashing dominate. The baseline also spends time in `linkify-it.test`; the GFM path skips paragraphs without HTTP, `www.` or email markers. That accounts for the measured worker improvement.

The 14-core host had other builds and system services active. Alternating samples reduce drift but do not establish app launch, memory or large-file performance. No full `perf:gate` ran, as requested.

## Checks

| Check | Result |
| --- | --- |
| `bun run build:native`, run first | Passed |
| `bun run typecheck` | Passed |
| `bun run test` | 204 passed, 0 failed |
| `bun run test:corpus` | 41 documents, 0 semantic edits; both tests passed |
| `bun run test:packaging` | 13 passed, 0 failed |
| `bun run build` | Passed |
| `bunx tsgo --noEmit -p test/corpus/tsconfig.json` | Passed |
| `bun scripts/verify-smoke.ts render-links-pdf` | Passed, including cross-file heading scroll and PDF/HTML output |
| `bun scripts/verify-smoke.ts author-html` | Passed |
| `bun scripts/verify-smoke.ts mdx-editing` | Passed |
| `bun scripts/verify-smoke.ts mdx-invalid-recovery` | Passed |
| `bun scripts/verify-smoke.ts github-theme-images` | Passed, including decoded local picture sources |
| `git diff --check` | Passed |

These are local macOS checks. Hosted CI and Windows hardware were not run in this task. No push or pull request was made.

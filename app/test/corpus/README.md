# GitHub fidelity corpus

The 41 documents in `manifest.json` are public repository files pinned to full commit SHAs. `snapshots/` contains their complete Markdown and GitHub article HTML. `ATTRIBUTION.md` lists their licenses and cases. The original license and copyright notices are in `licenses/` or the document's own license section. Each snapshot keeps its upstream license. These files do not change the app's license.

The selection starts with the research candidate list. QLMarkdown's `examples/test1.md` replaces the Go README because it contains live display math and a math fence, aligned tables, footnotes and Mermaid. Dive into Deep Learning's linear algebra chapter replaces the Next.js README to cover live inline equations and longer technical math. Its snapshots retain CC BY-SA 4.0. The test checks live feature coverage so fenced examples cannot substitute for rendered math, pictures or diagrams. The four GitHub Docs documents are repository-source stress cases. Their frontmatter, Liquid and fenced examples remain intact. They are not snapshots of docs.github.com. A syntax example inside a code fence does not count as live feature coverage.

## Commands

From the repository root:

```sh
bun run typecheck
bun run test
bun run test:corpus
```

Normal tests compare all documents offline and write `.audit/corpus/report.md` and `report.json`. Semantic mismatches do not fail normal tests. Missing snapshots, changed hashes, a broken comparison, or failed normalizer checks do fail. `test:corpus` sets `SIMPLEMD_CORPUS_GATE=1` and requires zero mismatches. It is the M2 gate. There is no baseline allowlist for today's bugs.

`report.json` includes both normalized trees and every mismatch path. Category counts are DOM edit operations. A missing subtree counts once, so these counts are not feature counts or pass rates. Adjacent changes can affect edit alignment. The report records the renderer revision; uncommitted renderer changes require separate review.

The corpus uses Electron's DOMParser and the current `renderMarkdown()` implementation. The comparison bundles the existing `renderDiagrams()` function and checks its SVG output for every Mermaid block. A hidden, isolated Electron process denies all network requests. No images, iframes or author scripts execute. No DOM package enters the worker or production code. Electron's binary must be installed, as for other app workflows. To typecheck the test helpers too, run `bunx tsgo --noEmit -p test/corpus/tsconfig.json` from `app/`.

The test creates temporary repository folders with `.git` markers. This lets the production resolver discover the repository root for `/assets/...` and other root-relative paths. The normalizer maps each temporary file URL to its repository path. No repository is cloned and no source file is changed.

## Refresh

Only this explicit command fetches references:

```sh
cd app
bun test/corpus/refresh.ts
```

Edit `manifest.json` to change a pin. The script uses unauthenticated HTTPS GET with only User-Agent and Accept headers. It never reads a token, credential store or Git configuration. Requests are sequential, at least 1.1 seconds apart. Rate-limit responses receive at most two retries, with Retry-After respected up to 60 seconds per retry. Longer limits require a later explicit rerun.

For every pin, the script fetches raw Markdown and the github.com repository file page. It extracts the `article.markdown-body` element from server HTML or the page's embedded `richText`. It rejects truncated articles. If that fails, it prints the URL, HTTP status or extraction error, then requests the same document and SHA from the Contents API with `Accept: application/vnd.github.html+json`. It never calls `/markdown`. `receipts.json` and `ATTRIBUTION.md` identify each fallback. A failed source, fallback or license request leaves the checked-in references intact. Staged downloads stay in `.refresh/` for inspection until the next run.

Receipts record source and reference SHA-256 hashes, the file-page response hash, pin URLs, fetch timestamps, page HTTP status and the method. Tests verify source and reference hashes without network access. Refresh rejects source, article and license payloads over 5,000,000 bytes in total. Only text snapshots and license notices are stored. External asset URLs remain as text.

## Named normalizations

These rules apply to both sides. They remove implementation differences while keeping content, nesting, targets and feature presence.

| Rule | Transformation | Preserved checks |
| --- | --- | --- |
| N01 HTML DOM | Parse with Electron DOMParser. The HTML parser handles tag case, entities, malformed nesting and implicit tbody elements. Drop comments. | Ordered elements, decoded text and document structure. |
| N02 wrappers | Unwrap article, markdown-heading, markdown-accessiblity-table, themed-picture, highlight, snippet-clipboard-content and app code-block containers. Unwrap image links only when the link target equals the image source. | Headings, tables, pictures, image sources and explicit author links. |
| N03 generated chrome | Remove heading permalink anchors and their octicons, code copy controls empty plugin footnote-anchor elements and generated footnote separator rules. Move heading and footnote anchor IDs onto their semantic elements first. Remove alert and backlink SVG icons. | Heading IDs, alert kind and text, footnote link relationships. Copy-control accessibility is outside this corpus. |
| N04 presentation metadata | Drop classes after extracting alert kinds, code languages, footnotes and generated math/diagram markers. Drop data attributes after consuming canonical URLs and enrichment markers. Drop style except text-align, and rel, target, itemprop, loading and decoding. Ignore generated dir=auto, inline-code dir=ltr and heading tabindex=-1. | Picture media, dimensions, alignment, language, boolean state, ordinary accessibility attributes and unknown HTML attributes. |
| N05 IDs | Remove user-content- prefixes. Remove 32-hex run suffixes only from GitHub footnote IDs. Map footnote definitions and repeated references to positional logical IDs. Canonicalize the plugin's bracketed reference numbers and backlink glyphs. | Distinct IDs, repeated references, href targets and backlinks. Missing footnote labels remain gaps. |
| N06 URLs | Prefer data-canonical-src and decode Camo's hex URL when needed. Map known repository redirects and expiring GitHub attachment CDN URLs to their permanent identities. Map the pinned repository's blob/raw URLs, relative paths and the test's file URLs to repo paths. Remove GitHub's raw query parameter only on resources mapped to that repository. Parse srcset candidates with whitespace, URL tokens and parenthesized descriptors. | External destinations, remaining queries, percent encoding, fragments, theme fragments, picture sources and media queries. |
| N07 code | Compare pre/code by decoded text and language. Remove token spans and one terminal LF from both sides. Normalize CRLF/CR. Map GitHub lexer names and js/jsx/ts/tsx/sh/bash/yml/md/cmd/text/txt/plaintext/gitignore aliases. | Interior whitespace, blank lines, source characters and language. |
| N08 whitespace | Collapse HTML whitespace outside code. Merge adjacent text nodes and remove indentation at block boundaries. | Inline word separation, nonbreaking spaces, exact inline-code whitespace and all code-block contents under N07. No punctuation or Unicode normalization. |
| N09 math | Map GitHub math-renderer and generated KaTeX to TeX source, inline/display mode and presence. Remove outer math delimiters, edge whitespace and paragraphs containing only display math. KaTeX requires a TeX annotation. | Missing math, changed TeX, wrong mode and render errors. No glyph or layout comparison. |
| N10 Mermaid | Map GitHub enrichment sections and app Mermaid blocks to decoded source plus render presence. App presence requires the current DOM renderer to produce SVG without a visible error. | Missing diagrams, changed source and failed rendering. |
| N11 declared fences | Map only GeoJSON, TopoJSON and STL enrichment to its raw code fallback, as allowed by PLAN.md. | Language and code text. This does not grant support for interactive maps or models. |
| N12 emoji | Unwrap g-emoji around Unicode text. Map custom image emoji to their shortcode text, as allowed by PLAN.md. | Unicode emoji and ordinary image alt text. Missing shortcode support remains a gap. |
| N13 attributes | Sort attributes, canonicalize boolean attributes and equivalent s/strike tags to del. Map CSS text-align to align. | Checked/disabled/open state, table alignment and other semantic attributes. |

M2 fills in these named rules. None permits missing content or a new unsupported feature:

- N04a secured assets removes GitHub's `secured-asset-link` marker. This is GitHub asset-delivery metadata, not an author attribute or image destination.
- N09a math transport decodes one extra HTML-entity layer in GitHub's `math-renderer` payload. For example, its text node contains `&amp;` where the TeX source contains `&`. KaTeX annotations already contain decoded source. TeX commands, spacing and mode still compare exactly.
- N05 drops an ID that becomes empty after prefix removal, as it already does for a literal empty ID. N08 treats normalized code blocks as block boundaries when removing HTML indentation.
- N06 maps the pinned Prisma repository's `prisma/orm` redirect, legacy GitHub attachment URLs and their permanent asset IDs, and repository directory URLs with or without a trailing slash. Resource paths, queries and fragments remain significant. These are GitHub URL canonicalization differences, not permission to ignore destinations.

GitHub's saved math-renderer and enrichment elements prove source and server-side presence. They do not prove that GitHub's client-side hydration completed. The app's KaTeX output and Mermaid SVG checks prove local rendering only. Theme media and fragments are compared as DOM attributes; light/dark asset selection, font layout, image decoding, navigation and screenshots need separate runtime checks.

Focused positive and negative controls cover the normalizations and guard against hiding missing pictures, disclosures, math, diagrams, alignment, source spacing and link targets. The report uses grammar, text, sanitization, URL resolution, headings, footnotes, math, Mermaid, alerts, tables, accessibility and enrichment categories. Categories suggest where to investigate. The original and normalized trees are the evidence.

# M0c implementation report

Added 41 commit-pinned public Markdown sources, extracted GitHub article references, license notices, a refresh script, semantic normalization and an offline comparison test. The renderer and application behavior are unchanged. Package edits add only `test:corpus` at the app and workspace roots.

Renderer source revision: `a98679bfa4c39fbf21050fe663e330b817cc5286`. The corpus commit contains only test infrastructure, references and package scripts.

| Renderer file | SHA-256 |
| --- | --- |
| `app/src/main/markdown.ts` | `79446ef4e7394f3304df84abaf5cc9a73d121e6354ac4d01cb4761651f70bcf0` |
| `app/src/shared/markdown-parser.ts` | `bd6af7a8b3a3c76553d561f191bf916d75e35a45135e924537edf834c7b1bc71` |
| `app/src/renderer/diagrams.ts` | `c7702b26a02820190b37f2e7ae21589482bd013d51a9bd02063da9280fdd15a5` |

## Documents

[ATTRIBUTION.md](ATTRIBUTION.md) records each repository, path, full commit SHA and license. Cases below describe source coverage. Fenced syntax examples remain code; the test separately requires live math, diagrams, themed pictures, disclosures, alerts, aligned tables, footnotes, nested lists and duplicate/Unicode headings.

| Document | Cases |
| --- | --- |
| [facebook/react/README.md](snapshots/01-facebook-react-readme.md) | raw HTML, badges |
| [microsoft/vscode/README.md](snapshots/02-microsoft-vscode-readme.md) | raw HTML, centered logos, badges, nested lists |
| [microsoft/TypeScript/README.md](snapshots/03-microsoft-TypeScript-readme.md) | badges |
| [rust-lang/rust/README.md](snapshots/04-rust-lang-rust-readme.md) | raw HTML, centered logos, picture sources |
| [sbarex/QLMarkdown/examples/test1.md](snapshots/05-sbarex-qlmarkdown-test1.md) | raw HTML, table alignment, dollar-sign negative control, live display math, live math fence, Mermaid, footnote syntax, emoji shortcodes, nested lists |
| [nodejs/node/README.md](snapshots/06-nodejs-node-readme.md) | raw HTML, details/summary, nested lists |
| [denoland/deno/README.md](snapshots/07-denoland-deno-readme.md) | raw HTML, badges |
| [oven-sh/bun/README.md](snapshots/08-oven-sh-bun-readme.md) | raw HTML, centered logos, badges, nested lists |
| [sveltejs/svelte/README.md](snapshots/09-sveltejs-svelte-readme.md) | raw HTML, badges, picture sources |
| [vuejs/core/README.md](snapshots/10-vuejs-core-readme.md) | raw HTML, centered logos, badges |
| [vitejs/vite/README.md](snapshots/11-vitejs-vite-readme.md) | raw HTML, centered logos, badges, picture sources, tables, Unicode heading |
| [withastro/astro/README.md](snapshots/12-withastro-astro-readme.md) | raw HTML, centered logos, badges, tables |
| [d2l-ai/d2l-en/chapter_preliminaries/linear-algebra.md](snapshots/13-d2l-ai-d2l-en-linear-algebra.md) | live inline math, live display math, Unicode text and headings, long code blocks, nested lists |
| [tailwindlabs/tailwindcss/README.md](snapshots/14-tailwindlabs-tailwindcss-readme.md) | raw HTML, centered logos, badges, picture sources |
| [shadcn-ui/ui/README.md](snapshots/15-shadcn-ui-ui-readme.md) | plain Markdown control |
| [fastify/fastify/README.md](snapshots/16-fastify-fastify-readme.md) | raw HTML, centered logos, badges, tables, emoji shortcodes |
| [expressjs/express/Readme.md](snapshots/17-expressjs-express-readme.md) | raw HTML, badges, picture sources, details/summary, nested lists |
| [axios/axios/README.md](snapshots/18-axios-axios-readme.md) | raw HTML, centered logos, badges, tables, alerts, dollar syntax or code negative control, emoji shortcodes, nested lists, duplicate headings, long code |
| [lodash/lodash/README.md](snapshots/19-lodash-lodash-readme.md) | alerts |
| [webpack/webpack/README.md](snapshots/20-webpack-webpack-readme.md) | raw HTML, centered logos, badges, tables, emoji shortcodes, nested lists |
| [rollup/rollup/README.md](snapshots/21-rollup-rollup-readme.md) | raw HTML, centered logos, badges |
| [prettier/prettier/README.md](snapshots/22-prettier-prettier-readme.md) | raw HTML, centered logos, badges |
| [eslint/eslint/README.md](snapshots/23-eslint-eslint-readme.md) | raw HTML, centered logos, badges, nested lists |
| [pnpm/pnpm/README.md](snapshots/24-pnpm-pnpm-readme.md) | raw HTML, centered logos, badges, picture sources |
| [yarnpkg/berry/README.md](snapshots/25-yarnpkg-berry-readme.md) | raw HTML, centered logos, badges, dark/light image fragments |
| [supabase/supabase/README.md](snapshots/26-supabase-supabase-readme.md) | raw HTML, centered logos, badges, dark/light image fragments, nested lists |
| [appwrite/appwrite/README.md](snapshots/27-appwrite-appwrite-readme.md) | raw HTML, centered logos, badges, tables, Mermaid, emoji shortcodes, nested lists |
| [prisma/prisma/README.md](snapshots/28-prisma-prisma-readme.md) | raw HTML, centered logos, badges |
| [mermaid-js/mermaid/README.md](snapshots/29-mermaid-js-mermaid-readme.md) | raw HTML, centered logos, badges, Mermaid, emoji shortcodes, details/summary |
| [KaTeX/KaTeX/README.md](snapshots/30-KaTeX-KaTeX-readme.md) | raw HTML, badges, picture sources |
| [remarkjs/remark/readme.md](snapshots/31-remarkjs-remark-readme.md) | raw HTML, centered logos, badges, emoji shortcodes, details/summary, nested lists, reference links and images |
| [mdx-js/mdx/readme.md](snapshots/32-mdx-js-mdx-readme.md) | raw HTML, centered logos, badges |
| [syntax-tree/mdast/readme.md](snapshots/33-syntax-tree-mdast-readme.md) | raw HTML, footnote syntax, emoji shortcodes, nested lists, footnote examples inside code |
| [electron/electron/README.md](snapshots/34-electron-electron-readme.md) | badges, emoji shortcodes |
| [typst/typst/README.md](snapshots/35-typst-typst-readme.md) | raw HTML, centered logos, badges, dollar syntax or code negative control, footnote syntax, details/summary, nested lists, live footnotes, reference links |
| [jqlang/jq/README.md](snapshots/36-jqlang-jq-readme.md) | dollar syntax or code negative control |
| [cli/cli/README.md](snapshots/37-cli-cli-readme.md) | alerts |
| [github/docs/content/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions.md](snapshots/38-github-docs-writing-mathematical-expressions.md) | alerts, math fence examples, dollar syntax or code negative control, nested lists, fenced documentation examples and site frontmatter |
| [github/docs/content/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams.md](snapshots/39-github-docs-creating-diagrams.md) | alerts, Mermaid, nested lists, fenced documentation examples and site frontmatter |
| [github/docs/content/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections.md](snapshots/40-github-docs-organizing-information-with-collapsed-sections.md) | raw HTML, details/summary, nested lists, fenced documentation examples and site frontmatter |
| [github/docs/content/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax.md](snapshots/41-github-docs-basic-writing-and-formatting-syntax.md) | raw HTML, picture sources, tables, alerts, footnote syntax, emoji shortcodes, nested lists, fenced documentation examples and site frontmatter |

## Normalization

The named rules are documented in [README.md](README.md#named-normalizations) and implemented in [normalize.ts](normalize.ts).

- N01 parses HTML with Electron DOMParser.
- N02 unwraps GitHub and app presentation containers.
- N03 removes generated controls, permalink icons and footnote separators while preserving their semantic IDs.
- N04 removes presentation classes, data attributes and styles after reading their semantic values.
- N05 canonicalizes user-content prefixes, footnote run suffixes and link relationships.
- N06 maps Camo, known repository redirects, attachment CDN URLs and repository paths; preserves meaningful queries, fragments and picture media.
- N07 compares decoded code and canonical language names without highlighting spans.
- N08 canonicalizes HTML indentation while preserving inline separation and code whitespace.
- N09 compares TeX source, display mode and generated math presence.
- N10 compares Mermaid source and checks SVG success through the current app renderer.
- N11 compares GeoJSON, TopoJSON and STL as code under the declared exceptions.
- N12 compares custom image emoji as shortcode text and ordinary emoji as Unicode.
- N13 canonicalizes attribute order, boolean state, strikethrough tags and table alignment.

The controls require missing math, diagrams, disclosures, pictures, table alignment, source spacing and link targets to remain mismatches. Reference hashes and live corpus coverage also gate normal tests.

## Gap summary

The current renderer produces 1,810 semantic edits across 41 documents. 40 documents have gaps. These are DOM edit counts, not independent bug counts. A missing subtree counts once. Adjacent changes can affect edit alignment.

| Category | Edits |
| --- | ---: |
| grammar | 426 |
| text | 205 |
| sanitization | 778 |
| url-resolution | 105 |
| headings | 83 |
| footnotes | 1 |
| math | 19 |
| mermaid | 0 |
| alerts | 0 |
| tables | 144 |
| accessibility | 23 |
| enrichment | 26 |

M1 investigation starts with escaped author HTML, lost logos/pictures/disclosures, HTML tables and URL resolution. M2 investigation starts with smart punctuation, shortcode emoji, heading slugs, code/grammar differences, math fences and footnote accessibility. Table counts include HTML tables and GitHub frontmatter tables. Ordinary aligned GFM tables pass the focused control.

The math count includes differences in GitHub's preprocessing of TeX escapes, entities and indentation, plus cases the two parsers recognize differently. It is not a count of confirmed broken equations. Mermaid and alerts have zero semantic edits in this corpus. That proves the checked sources and local diagram output only. GitHub hydration, theme selection, image loading, navigation and layout remain separate runtime checks.

Per-document edits:

| Document | Edits | Categories |
| --- | ---: | --- |
| 01-facebook-react-readme | 5 | headings: 1, text: 4 |
| 02-microsoft-vscode-readme | 9 | headings: 1, text: 4, grammar: 1, sanitization: 3 |
| 03-microsoft-TypeScript-readme | 0 | none |
| 04-rust-lang-rust-readme | 5 | sanitization: 1, grammar: 1, text: 3 |
| 05-sbarex-qlmarkdown-test1 | 28 | tables: 1, enrichment: 2, text: 8, math: 1, grammar: 11, accessibility: 5 |
| 06-nodejs-node-readme | 22 | text: 2, grammar: 15, sanitization: 3, headings: 2 |
| 07-denoland-deno-readme | 4 | sanitization: 2, grammar: 1, text: 1 |
| 08-oven-sh-bun-readme | 27 | grammar: 3, sanitization: 14, headings: 1, text: 9 |
| 09-sveltejs-svelte-readme | 6 | sanitization: 1, text: 5 |
| 10-vuejs-core-readme | 24 | headings: 2, text: 5, grammar: 6, sanitization: 11 |
| 11-vitejs-vite-readme | 37 | grammar: 11, sanitization: 24, text: 2 |
| 12-withastro-astro-readme | 19 | grammar: 10, sanitization: 8, text: 1 |
| 13-d2l-ai-d2l-en-linear-algebra | 121 | enrichment: 5, grammar: 67, text: 27, math: 18, headings: 4 |
| 14-tailwindlabs-tailwindcss-readme | 31 | grammar: 7, sanitization: 23, text: 1 |
| 15-shadcn-ui-ui-readme | 1 | url-resolution: 1 |
| 16-fastify-fastify-readme | 16 | sanitization: 6, grammar: 6, text: 4 |
| 17-expressjs-express-readme | 9 | sanitization: 3, text: 1, headings: 2, grammar: 3 |
| 18-axios-axios-readme | 56 | text: 17, headings: 4, tables: 3, sanitization: 19, grammar: 13 |
| 19-lodash-lodash-readme | 7 | text: 1, sanitization: 2, grammar: 4 |
| 20-webpack-webpack-readme | 525 | sanitization: 361, grammar: 64, text: 12, tables: 88 |
| 21-rollup-rollup-readme | 121 | grammar: 16, sanitization: 96, headings: 1, text: 8 |
| 22-prettier-prettier-readme | 51 | headings: 1, grammar: 21, sanitization: 28, text: 1 |
| 23-eslint-eslint-readme | 50 | sanitization: 8, grammar: 16, text: 17, headings: 5, tables: 4 |
| 24-pnpm-pnpm-readme | 8 | sanitization: 1, text: 2, grammar: 2, tables: 3 |
| 25-yarnpkg-berry-readme | 37 | grammar: 8, sanitization: 16, text: 11, tables: 2 |
| 26-supabase-supabase-readme | 109 | grammar: 29, sanitization: 17, text: 4, accessibility: 12, tables: 1, url-resolution: 46 |
| 27-appwrite-appwrite-readme | 29 | sanitization: 1, grammar: 9, headings: 1, tables: 1, enrichment: 17 |
| 28-prisma-prisma-readme | 40 | grammar: 4, sanitization: 22, url-resolution: 9, text: 5 |
| 29-mermaid-js-mermaid-readme | 99 | grammar: 25, sanitization: 16, headings: 54, enrichment: 1, text: 3 |
| 30-KaTeX-KaTeX-readme | 35 | headings: 1, text: 4, sanitization: 25, grammar: 5 |
| 31-remarkjs-remark-readme | 30 | headings: 1, accessibility: 4, grammar: 21, sanitization: 2, url-resolution: 1, tables: 1 |
| 32-mdx-js-mdx-readme | 1 | tables: 1 |
| 33-syntax-tree-mdast-readme | 3 | headings: 1, grammar: 2 |
| 34-electron-electron-readme | 4 | enrichment: 1, text: 3 |
| 35-typst-typst-readme | 34 | headings: 1, grammar: 9, sanitization: 12, text: 10, accessibility: 2 |
| 36-jqlang-jq-readme | 5 | text: 5 |
| 37-cli-cli-readme | 4 | text: 3, grammar: 1 |
| 38-github-docs-writing-mathematical-expressions | 18 | tables: 1, sanitization: 5, grammar: 4, url-resolution: 7, text: 1 |
| 39-github-docs-creating-diagrams | 11 | tables: 1, url-resolution: 9, text: 1 |
| 40-github-docs-organizing-information-with-collapsed-sections | 7 | tables: 1, text: 3, url-resolution: 3 |
| 41-github-docs-basic-writing-and-formatting-syntax | 162 | tables: 36, sanitization: 48, grammar: 31, url-resolution: 29, text: 17, footnotes: 1 |

The full rerunnable report is `.audit/corpus/report.md`; `.audit/corpus/report.json` contains both normalized trees and every mismatch path. `bun run test` regenerates these files without fetching references. `bun run test:corpus` requires zero unexplained mismatches.

## Acquisition and size

All 41 source/article pairs came from plain unauthenticated HTTPS GET. All file pages returned HTTP 200. References are `article.markdown-body` elements from github.com at the pinned commits. There were no Contents API fallbacks and no `/markdown` calls. No token or credentials were used. [receipts.json](receipts.json) records dates, URLs and hashes.

Requests were sequential and spaced by at least 1.1 seconds. The refresh script handles rate-limit responses and leaves checked-in references intact if fetching fails. It retains text only. Images and other binary assets are not downloaded.

Source, HTML and license payloads total 2,961,666 bytes. The full corpus directory, including this report and test helpers, totals 3,070,434 bytes.

## Checks

- `bun run typecheck`: passed.
- `cd app && bunx tsgo --noEmit -p test/corpus/tsconfig.json`: passed.
- `bun run test`: passed, 125 tests, 590 assertions.
- `bun run test:corpus`: exited 1 as expected, with 1,810 semantic edits.
- `git diff --check`: passed for authored files. Upstream snapshots and license notices retain their original whitespace.

No renderer fixes, product renames, push or pull request were included.

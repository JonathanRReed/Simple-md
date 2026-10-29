# Author HTML sanitizer

Milestone 1. Applies to every place HTML reaches a DOM: read view, live-preview widgets, export, print, Quick Look and the Windows preview handler.

## Where it runs

- One function, `sanitizeAuthorHtml()`, runs in a DOM context: the Electron renderer or WebView2. It does not run in the Node worker. Do not add jsdom or linkedom.
- Quick Look renders in JavaScriptCore with no DOM (see `quick-look.md`). It must enforce this same policy and prove parity with a differential test against this function's output on every fixture.
- It runs before every HTML insertion. A test fails if any other `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `DOMParser` path inserts author content.
- A raw HTML wrapper that spans Markdown blocks, such as `<details>` around Markdown content, is sanitized as one balanced unit and becomes one render block. Opening and closing tags are never sanitized separately. Block identities added in milestone 3 must keep this grouping.
- App-generated markup (Shiki, KaTeX, task checkboxes, alert icons, footnotes, diagram SVG) is added through app-owned render nodes with their own policies. It is never re-sanitized with the author policy. Author `class`, `style`, `data-*`, custom elements, or a fake `class="mermaid"` never gain generated-content privileges.

## Policy

It mirrors GitHub's historical html-pipeline allow-list. Use a dedicated DOMPurify instance.

```ts
const authorTags = `
  h1 h2 h3 h4 h5 h6 br b i strong em a pre code img tt div ins del
  sup sub p picture ol ul table thead tbody tfoot blockquote dl dt dd
  kbd q samp var hr ruby rt rp li tr td th s strike summary details
  mark source span video
`.trim().split(/\s+/);

const globalAttrs = `
  abbr accept accept-charset accesskey action align alt axis cellpadding
  cellspacing char charoff charset checked clear cols colspan color compact
  coords datetime dir disabled enctype for frame headers height hreflang
  hspace id ismap label lang maxlength media method multiple name nohref
  noshade nowrap open prompt readonly rev rows rowspan rules scope selected
  shape size span start summary tabindex title type usemap valign value
  width itemprop
`.trim().split(/\s+/);

const perTag: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "longdesc"],
  div: ["itemscope", "itemtype"],
  blockquote: ["cite"], del: ["cite"], ins: ["cite"], q: ["cite"],
  source: ["srcset"],
  video: ["src", "controls", "muted"],
};

const authorPolicy = {
  ALLOWED_TAGS: authorTags,
  ALLOWED_ATTR: [...new Set([...globalAttrs, ...Object.values(perTag).flat()])],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORBID_ATTR: ["style", "class", "is"],
  SANITIZE_DOM: true,
  SANITIZE_NAMED_PROPS: true,
  KEEP_CONTENT: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  CUSTOM_ELEMENT_HANDLING: {
    tagNameCheck: null,
    attributeNameCheck: null,
    allowCustomizedBuiltInElements: false,
  },
  RETURN_DOM_FRAGMENT: true,
};
```

An `uponSanitizeAttribute` hook enforces per-tag attributes (global attributes plus that tag's `perTag` list only).

## URLs

- One URL resolver handles Markdown links, HTML `href`, `src` and `srcset`, Astro `public/` root paths, and fragments.
- Resources (`img`, `source`, `video`) allow `https:`, `http:` and relative URLs only. No `data:` or `file:` from author content. Parse each `srcset` candidate properly; never split blindly at commas. Validate again after resolution.
- Anchors also allow `mailto:`. The main-process opener keeps accepting only HTTP, HTTPS and mailto for external navigation.
- Remote images load by default. Config key `remote-images = true | false`. The CSP adds `media-src` for `<video>`.
- Relative local images resolve through the app's existing local-file protocol, never by enabling author `file:` URLs.

## IDs and fragments

Prefix author `id` and `name` values once and keep an explicit fragment map. Anchor lookup stays inside the document root. Rewrite fragment and IDREF links consistently.

## Required fixtures

Mixed-case tags, entity and control-character URL tricks, malformed tables, SVG and MathML namespace switches, duplicate IDs, `name=doc` clobbering, custom elements, image data URLs, `srcset` edge cases, remote and relative SVG images, wrappers that span blocks, and spoofing of generated classes. Each fixture records the expected sanitized DOM.

Source: `.audit/research/c-fidelity-mdx.md` section 3 (local only).

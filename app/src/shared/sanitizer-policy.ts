// Shared with the DOM renderer and the future DOM-free Quick Look policy walker.
export const authorTags = `
h1 h2 h3 h4 h5 h6 br b i strong em a pre code img tt div ins del
sup sub p picture ol ul table thead tbody tfoot blockquote dl dt dd
kbd q samp var hr ruby rt rp li tr td th s strike summary details
mark source span video figure figcaption
`.trim().split(/\s+/);
export const globalAttrs = `
abbr accept accept-charset accesskey action align alt axis cellpadding
cellspacing char charoff charset checked clear cols colspan color compact
coords datetime dir disabled enctype for frame headers height hreflang
hspace id ismap label lang maxlength media method multiple name nohref
noshade nowrap open prompt readonly rev rows rowspan rules scope selected
shape size span start summary tabindex title type usemap valign value
width itemprop
`.trim().split(/\s+/);
export const perTag: Record<string, string[]> = {
  a: ["href"], img: ["src", "longdesc"], div: ["itemscope", "itemtype"],
  blockquote: ["cite"], del: ["cite"], ins: ["cite"], q: ["cite"],
  source: ["srcset"], video: ["src", "controls", "muted"],
};
export const authorPolicy = {
  ALLOWED_TAGS: authorTags,
  ALLOWED_ATTR: [...new Set([...globalAttrs, ...Object.values(perTag).flat()])],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORBID_ATTR: ["style", "class", "is"],
  SANITIZE_DOM: true,
  SANITIZE_NAMED_PROPS: true,
  KEEP_CONTENT: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  CUSTOM_ELEMENT_HANDLING: { tagNameCheck: null, attributeNameCheck: null, allowCustomizedBuiltInElements: false },
  RETURN_DOM_FRAGMENT: true as const,
};
export const FRAGMENT_PREFIX = "user-content-";
export const prefixFragment = (id: string) => id.startsWith(FRAGMENT_PREFIX) ? id : FRAGMENT_PREFIX + id;

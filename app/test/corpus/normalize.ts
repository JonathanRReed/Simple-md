export interface Context {
  repo: string;
  path: string;
  commit: string;
  side: "github" | "simplemd";
  canonicalRepo?: string;
  localRoot?: string;
  diagrams?: { source: string; rendered: boolean }[];
}

export interface SemanticNode {
  tag: string;
  attrs: Record<string, string>;
  children: SemanticNode[];
  text?: string;
}

const element = (tag: string, attrs: Record<string, string> = {}, children: SemanticNode[] = []): SemanticNode => ({ tag, attrs, children });
const text = (value: string): SemanticNode => ({ tag: "#text", attrs: {}, children: [], text: value });
const canonicalId = (value: string) => {
  const unprefixed = value.replace(/^(?:user-content-)+/, "");
  return /^fn(?:ref)?-/.test(unprefixed) ? unprefixed.replace(/-[a-f0-9]{32}(?=-|$)/g, "") : unprefixed;
};
const codeText = (value: string) => value.replace(/\r\n?/g, "\n").replace(/\n$/, "");
const mathText = (value: string) => value.trim().replace(/^\$\$([\s\S]*)\$\$$/, "$1").replace(/^\$`([\s\S]*)`\$$/, "$1").replace(/^\$([\s\S]*)\$$/, "$1").trim();
const blockTags = new Set("article div p h1 h2 h3 h4 h5 h6 section ul ol li table thead tbody tfoot tr th td blockquote pre code-block details summary hr dl dt dd math mermaid".split(" "));
const booleanAttrs = new Set(["checked", "disabled", "open", "controls", "muted", "readonly", "multiple", "selected"]);

// N01 DOM parsing, N02 wrappers, N03 chrome, N04 presentation, N05 IDs,
// N06 URLs, N07 code, N08 whitespace, N09 math, N10 Mermaid,
// N11 declared exceptions, N12 emoji, N13 attributes. See README.md.
export function normalizeHtml(html: string, context: Context): SemanticNode {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  const ids = new Map<string, string>();
  for (const [i, li] of [...body.querySelectorAll("section.footnotes > ol > li[id]")].entries()) {
    ids.set(canonicalId(li.id), `fn:${i + 1}`);
  }
  const refCounts = new Map<string, number>();
  for (const ref of body.querySelectorAll("a[data-footnote-ref], a.footnote-ref, sup.footnote-ref > a")) {
    const target = canonicalId((ref.getAttribute("href") ?? "").replace(/^#/, ""));
    const targetId = ids.get(target);
    if (!targetId) continue;
    const count = (refCounts.get(targetId) ?? 0) + 1;
    refCounts.set(targetId, count);
    const siblingAnchor = ref.parentElement?.querySelector("a.footnote-anchor[id]");
    if (!ref.id && siblingAnchor) ref.id = siblingAnchor.id;
    if (ref.id) ids.set(canonicalId(ref.id), `fnref:${targetId.slice(3)}:${count}`);
    const parent = ref.parentElement;
    if (parent?.id && parent.tagName === "SUP") ids.set(canonicalId(parent.id), `fnref:${targetId.slice(3)}:${count}`);
  }
  const id = (value: string) => ids.get(canonicalId(value)) ?? canonicalId(value);
  for (const wrapper of body.querySelectorAll(".markdown-heading")) {
    const heading = wrapper.querySelector("h1,h2,h3,h4,h5,h6");
    const anchor = wrapper.querySelector("a.anchor[id]");
    if (heading && anchor) heading.id = anchor.id;
  }

  function url(value: string, kind: string): string {
    if (value.startsWith("#")) return `#${id(value.slice(1))}`;
    if (value.startsWith("https://camo.githubusercontent.com/")) {
      const hex = value.split("/").at(-1) ?? "";
      if (/^(?:[a-f0-9]{2})+$/i.test(hex)) {
        const decoded = new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16)));
        if (/^https?:/.test(decoded)) value = decoded;
      }
    }
    const attachment = /^https:\/\/private-user-images\.githubusercontent\.com\/\d+\/\d+-([a-f0-9-]{36})\.[^?#]+\?jwt=/.exec(value);
    if (attachment) return `https://github.com/user-attachments/assets/${attachment[1]}`;
    const asset = /^https:\/\/github\.com\/[^/]+\/[^/]+\/assets\/\d+\/([a-f0-9-]{36})(?=$|[?#])/.exec(value);
    if (asset) value = value.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/assets\/\d+\//, "https://github.com/user-attachments/assets/");
    const local = context.localRoot ?? `file:///__corpus__/${context.repo}/`;
    if (value.startsWith(local)) return `repo:${value.slice(local.length).replace(/\/(?=[?#]|$)/, "")}`;
    if (/^(?:data:|mailto:|file:)/i.test(value)) return value;
    const base = `https://github.com/${context.repo}/blob/${context.commit}/${context.path}`;
    let resolved: URL;
    try { resolved = new URL(value, base); } catch { return value; }
    const prefixes = [context.repo, ...(context.canonicalRepo ? [context.canonicalRepo] : [])].flatMap((repo) => [
      `https://github.com/${repo}/blob/${context.commit}/`,
      `https://github.com/${repo}/raw/${context.commit}/`,
      `https://raw.githubusercontent.com/${repo}/${context.commit}/`,
    ]);
    for (const prefix of prefixes) {
      if (resolved.href.startsWith(prefix)) {
        if (kind !== "href") resolved.searchParams.delete("raw");
        const logical = resolved.href.slice(prefix.length).replace(/\/(?=[?#]|$)/, "");
        const split = logical.indexOf("#");
        return `repo:${split < 0 ? logical : logical.slice(0, split) + "#" + id(logical.slice(split + 1))}`;
      }
    }
    return resolved.href;
  }

  function srcset(value: string): string {
    const candidates: string[] = [];
    let rest = value.trim();
    while (rest) {
      rest = rest.replace(/^[\s,]+/, "");
      const resource = /^\S+/.exec(rest)?.[0];
      if (!resource) break;
      rest = rest.slice(resource.length);
      if (resource.endsWith(",")) { candidates.push(url(resource.replace(/,+$/, ""), "src")); continue; }
      let end = 0;
      let parentheses = 0;
      while (end < rest.length) {
        const char = rest[end]!;
        if (char === "(" ) parentheses++;
        if (char === ")") parentheses--;
        if (char === "," && parentheses === 0) break;
        end++;
      }
      const descriptor = rest.slice(0, end).trim().replace(/\s+/g, " ");
      candidates.push(url(resource, "src") + (descriptor ? ` ${descriptor}` : ""));
      rest = rest.slice(end + 1);
    }
    return candidates.join(", ");
  }

  function children(parent: Node, preserve = false): SemanticNode[] {
    const result: SemanticNode[] = [];
    for (const child of parent.childNodes) {
      for (const next of visit(child, preserve)) {
        const previous = result.at(-1);
        if (previous?.tag === "#text" && next.tag === "#text") previous.text += next.text ?? "";
        else result.push(next);
      }
    }
    if (!preserve) {
      for (let i = result.length - 1; i >= 0; i--) {
        const node = result[i]!;
        if (node.tag !== "#text") continue;
        let value = node.text ?? "";
        if (i === 0 || blockTags.has(result[i - 1]!.tag)) value = value.replace(/^ +/, "");
        if (i === result.length - 1 || blockTags.has(result[i + 1]!.tag)) value = value.replace(/ +$/, "");
        node.text = value;
        if (!value) result.splice(i, 1);
      }
    }
    return result;
  }

  function visit(node: Node, preserve: boolean): SemanticNode[] {
    if (node.nodeType === Node.TEXT_NODE) return [text(preserve ? node.textContent ?? "" : (node.textContent ?? "").replace(/[\t\n\r\f ]+/g, " "))];
    if (!(node instanceof Element)) return [];
    const tag = node.localName;
    if (node.matches("a.anchor, a.footnote-anchor, hr.footnotes-sep, button.copy-code, .zeroclipboard-container, svg.octicon, .markdown-alert-title svg, .footnote-backref svg, .data-footnote-backref svg")) return [];
    if (tag === "g-emoji") {
      if (node.querySelector("img")) return [text(node.getAttribute("alias") ? `:${node.getAttribute("alias")}:` : node.textContent ?? "")];
      return children(node, preserve);
    }
    if (tag === "img" && node.classList.contains("emoji")) return [text(node.getAttribute("alt") ?? "")];
    if (tag === "math-renderer" || node.matches(".katex-display, .katex:not(.katex-display .katex)")) {
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      let source = tag === "math-renderer" ? mathText(node.textContent ?? "") : (annotation?.textContent ?? "").trim();
      if (tag === "math-renderer") {
        // GitHub transports already-escaped TeX inside an HTML text node.
        const decoded = doc.createElement("textarea");
        decoded.innerHTML = source.replace(/</g, "&lt;");
        source = decoded.value;
      }
      const display = node.classList.contains("js-display-math") || node.classList.contains("katex-display");
      return [element("math", { mode: display ? "display" : "inline", rendered: String(tag === "math-renderer" || !!annotation), source })];
    }
    if (tag === "section" && node.getAttribute("data-type") === "mermaid") {
      const raw = node.querySelector('pre[lang="mermaid"]');
      return [element("mermaid", { source: codeText(raw?.textContent ?? ""), rendered: String(!!raw) })];
    }
    if (node.matches("pre.mermaid")) {
      const source = node.textContent ?? "";
      const rendered = context.diagrams?.find((diagram) => diagram.source === source)?.rendered ?? false;
      return [element("mermaid", { source: codeText(source), rendered: String(rendered) })];
    }
    if (tag === "section" && /^(geojson|topojson|stl)$/.test(node.getAttribute("data-type") ?? "")) {
      const raw = node.querySelector("pre");
      return [element("code-block", { language: node.getAttribute("data-type")! }, [text(codeText(raw?.textContent ?? ""))])];
    }
    if (tag === "pre") {
      const code = node.querySelector("code");
      const owner = node.closest('[class*="highlight-source-"], [class*="highlight-text-"]');
      const language = /language-([^\s]+)/.exec(code?.className ?? "")?.[1]
        ?? /highlight-(?:source|text)-([^\s]+)/.exec(owner?.className ?? "")?.[1]
        ?? node.getAttribute("lang") ?? node.parentElement?.getAttribute("data-lang") ?? "";
      const aliases: Record<string, string> = { jsx: "javascript", tsx: "typescript", md: "markdown", "html-basic": "html", "html-php": "php", "shell-session": "console", batchfile: "batch", cmd: "batch", ts: "typescript", js: "javascript", sh: "shell", bash: "shell", shell: "shell", yml: "yaml", text: "", plaintext: "", txt: "", gitignore: "ini" };
      return [element("code-block", { language: aliases[language] ?? language }, [text(codeText(code?.textContent ?? node.textContent ?? ""))])];
    }
    if (node.matches("a") && node.children.length === 1 && node.firstElementChild?.matches("img") && ![...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) {
      const img = node.firstElementChild;
      const src = img.getAttribute("data-canonical-src") ?? img.getAttribute("src") ?? "";
      if (url(node.getAttribute("href") ?? "", "src") === url(src, "src")) return children(node, preserve);
    }
    if (tag === "article" || tag === "markdown-accessiblity-table" || tag === "themed-picture" || node.matches(".markdown-heading, .highlight, .snippet-clipboard-content, .code-block")) return children(node, preserve);
    const attrs: Record<string, string> = {};
    for (const attr of node.attributes) {
      if (attr.name.startsWith("data-") || ["class", "style", "rel", "target", "itemprop", "loading", "decoding", "secured-asset-link"].includes(attr.name)) continue;
      if ((attr.name === "dir" && attr.value === "auto") || (attr.name === "dir" && attr.value === "ltr" && tag === "code") || (attr.name === "tabindex" && attr.value === "-1" && /^h[1-6]$/.test(tag))) continue;
      if (attr.name === "id" && !canonicalId(attr.value)) continue;
      if (["id", "name"].includes(attr.name)) attrs[attr.name] = id(attr.value);
      else if (["href", "src", "poster"].includes(attr.name)) attrs[attr.name] = url(attr.value, attr.name);
      else if (attr.name === "srcset") attrs.srcset = srcset(attr.value);
      else if (attr.name === "media") attrs.media = node.getAttribute("data-simplemd-media") ?? attr.value;
      else if (attr.name === "aria-describedby" || attr.name === "aria-labelledby") attrs[attr.name] = attr.value.split(/\s+/).map(id).join(" ");
      else attrs[attr.name] = booleanAttrs.has(attr.name) ? "true" : attr.value;
    }
    if (tag === "img" && node.hasAttribute("data-canonical-src")) attrs.src = url(node.getAttribute("data-canonical-src")!, "src");
    const align = /(?:^|;)\s*text-align:\s*(left|center|right)/.exec(node.getAttribute("style") ?? "")?.[1];
    if (align) attrs.align = align;
    const alert = [...node.classList].find((name) => /^markdown-alert-(note|tip|important|warning|caution)$/.test(name));
    if (alert) attrs.kind = alert.slice("markdown-alert-".length);
    if (node.classList.contains("footnotes")) attrs.kind = "footnotes";
    if (node.matches(".footnote-backref, [data-footnote-backref]")) {
      attrs.kind = "footnote-backref";
      return [element("a", attrs, [text("↩")])];
    }
    if (tag === "a" && attrs.href?.startsWith("#fn:")) {
      return [element("a", attrs, [text(attrs.href.slice(4))])];
    }
    const normalizedChildren = children(node, preserve || tag === "code");
    if (tag === "p" && normalizedChildren.length === 1 && normalizedChildren[0]?.tag === "math" && normalizedChildren[0].attrs.mode === "display") return normalizedChildren;
    const normalizedTag = tag === "s" || tag === "strike" ? "del" : tag;
    return [element(normalizedTag, Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))), normalizedChildren)];
  }
  return element("document", {}, children(body));
}

export const categories = ["grammar", "text", "sanitization", "url-resolution", "headings", "footnotes", "math", "mermaid", "alerts", "tables", "accessibility", "enrichment"] as const;
export type Category = typeof categories[number];
export interface Mismatch { category: Category; path: string; expected: SemanticNode | string | undefined; actual: SemanticNode | string | undefined }

export function compare(expected: SemanticNode, actual: SemanticNode): Mismatch[] {
  const differences: Mismatch[] = [];
  const category = (a: SemanticNode | undefined, b: SemanticNode | undefined, location: string, attribute?: string): Category => {
    if (attribute?.startsWith("aria-") || attribute === "role" || a?.attrs.id === "footnote-label" || b?.attrs.id === "footnote-label") return "accessibility";
    if (/math/.test(location) || a?.tag === "math" || b?.tag === "math") return "math";
    if (/mermaid/.test(location) || a?.tag === "mermaid" || b?.tag === "mermaid") return "mermaid";
    if (/footnote|fn:|fnref:/.test(location + JSON.stringify(a?.attrs) + JSON.stringify(b?.attrs))) return "footnotes";
    if (/\/h[1-6]\[/.test(location)) return "headings";
    if (/\/table\[/.test(location)) return "tables";
    if (a?.attrs.kind || b?.attrs.kind || /alert/.test(location)) return "alerts";
    if (["href", "src", "srcset", "media"].includes(attribute ?? "")) return "url-resolution";
    if (/<\/?[a-z][\s\S]*>/i.test((a?.text ?? "") + (b?.text ?? "")) || [a?.tag, b?.tag].some((tag) => ["picture", "source", "img", "details", "summary", "kbd", "div", "a"].includes(tag ?? ""))) return "sanitization";
    if (/:[+\w-]+:/.test((a?.text ?? "") + (b?.text ?? ""))) return "enrichment";
    return a?.tag === "#text" && b?.tag === "#text" ? "text" : "grammar";
  };
  const diff = (a: SemanticNode | undefined, b: SemanticNode | undefined, location: string) => {
    if (!a || !b || a.tag !== b.tag) { differences.push({ category: category(a, b, location), path: location, expected: a, actual: b }); return; }
    for (const attr of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
      if (a.attrs[attr] !== b.attrs[attr]) differences.push({ category: category(a, b, location, attr), path: `${location}/@${attr}`, expected: a.attrs[attr], actual: b.attrs[attr] });
    }
    if (a.text !== b.text) differences.push({ category: category(a, b, location), path: location, expected: a.text, actual: b.text });
    // Exact-subtree anchors prevent one missing block from shifting the rest of a document.
    const left = a.children.map((node) => JSON.stringify(node));
    const right = b.children.map((node) => JSON.stringify(node));
    const matrix = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) matrix[i]![j] = left[i] === right[j] ? matrix[i + 1]![j + 1]! + 1 : Math.max(matrix[i + 1]![j]!, matrix[i]![j + 1]!);
    let i = 0; let j = 0;
    let pendingLeft: number[] = []; let pendingRight: number[] = [];
    const flush = () => {
      for (let n = 0; n < Math.max(pendingLeft.length, pendingRight.length); n++) {
        const ai = pendingLeft[n]; const bi = pendingRight[n];
        const aa = ai === undefined ? undefined : a.children[ai];
        const bb = bi === undefined ? undefined : b.children[bi];
        diff(aa, bb, `${location}/${aa?.tag ?? bb?.tag}[${ai ?? `+${bi}`}]`);
      }
      pendingLeft = []; pendingRight = [];
    };
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { flush(); i++; j++; }
      else if (j < right.length && (i === left.length || matrix[i]![j + 1]! > matrix[i + 1]![j]!)) pendingRight.push(j++);
      else pendingLeft.push(i++);
    }
    flush();
  };
  diff(expected, actual, "document");
  return differences;
}

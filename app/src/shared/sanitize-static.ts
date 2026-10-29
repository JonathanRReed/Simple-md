import "./static-runtime.js";
import { parse, parseFragment, serialize, defaultTreeAdapter as tree, html as htmlNames,
  type DefaultTreeAdapterTypes as P } from "parse5";
import GithubSlugger from "github-slugger";
import { authorPolicy, globalAttrs, perTag, prefixFragment } from "./sanitizer-policy.js";
import { resolveAuthorUrl, resolveSrcset, resolveFragment, type UrlContext } from "./url-resolver.js";
import type { RenderNode, RenderedHtml } from "./render-tree.js";

export interface StaticAuthorOptions { urls?: UrlContext; remoteImages?: boolean }
const tags = new Set(authorPolicy.ALLOWED_TAGS);
const globals = new Set(globalAttrs);
const forbiddenAttrs = new Set(authorPolicy.FORBID_ATTR);
// DOMPurify's default KEEP_CONTENT exclusions, not a second author allow-list.
const forbiddenContents = new Set("annotation-xml audio colgroup desc foreignobject head iframe math mi mn mo ms mtext noembed noframes noscript plaintext script selectedcontent style svg template thead title video xmp".split(" "));
const urlAttrs = new Set(["href", "src", "srcset", "longdesc", "cite", "action", "itemtype"]);
const uriSafeAttrs = new Set(["alt", "class", "for", "id", "label", "name", "pattern", "placeholder", "role", "summary", "title", "value", "style", "xmlns"]);
const uriPattern = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
const attrWhitespace = /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g;
const unsafeAttribute = /((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i;

function elements(root: P.ParentNode): P.Element[] {
  const result: P.Element[] = [];
  const stack = [...root.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!tree.isElementNode(node)) continue;
    result.push(node);
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
  return result;
}
function attr(node: P.Element, name: string): string | undefined { return node.attrs.find((a) => a.name === name)?.value; }
function setAttr(node: P.Element, name: string, value: string): void {
  const entry = node.attrs.find((a) => a.name === name);
  if (entry) entry.value = value;
  else node.attrs.push({ name, value });
}
function textContent(root: P.Element): string {
  const output: string[] = [];
  const stack = [...root.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (tree.isTextNode(node)) output.push(node.value);
    else if (tree.isElementNode(node)) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
  return output.join("");
}

type Originals = WeakMap<P.Element, Map<string, string>>;
function updateFragments(root: P.ParentNode, originals: Originals): void {
  const nodes = elements(root);
  const slugger = new GithubSlugger();
  for (const node of nodes) {
    if (!/^h[1-6]$/.test(node.tagName)) continue;
    let parent = node.parentNode;
    let footnote = false;
    while (parent && tree.isElementNode(parent)) {
      if (parent.tagName === "section" && attr(parent, "class")?.split(/\s+/).includes("footnotes")) footnote = true;
      parent = parent.parentNode;
    }
    if (footnote) continue;
    const slug = slugger.slug(textContent(node));
    if (!originals.get(node)?.has("id")) setAttr(node, "id", prefixFragment(slug));
  }
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const node of nodes) for (const name of ["id", "name"]) {
    const value = attr(node, name);
    if (value === undefined) continue;
    const source = originals.get(node)?.get(name) ?? value;
    const base = originals.get(node)?.has(name) ? prefixFragment(source) : source;
    let id = base;
    let suffix = 1;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    if (!map.has(source)) map.set(source, id);
    if (!map.has(base)) map.set(base, id);
    setAttr(node, name, id);
  }
  for (const node of nodes) for (const name of ["href", "for", "headers", "usemap"]) {
    const value = originals.get(node)?.get(name) ?? attr(node, name);
    if (value === undefined) continue;
    if (name === "href" || name === "usemap") {
      if (value.startsWith("#")) setAttr(node, name, resolveFragment(value, map));
    } else setAttr(node, name, value.split(/\s+/).map((id) => map.get(id) ?? prefixFragment(id)).join(" "));
  }
}

function sanitizeTree(html: string, options: StaticAuthorOptions, originals: Originals, slots: ReadonlySet<string>): P.DocumentFragment {
  // Match DOMParser(text/html), including head handling, table foster parenting,
  // adoption-agency repair and inert noscript parsing. Fragment parsing differs.
  const doc = parse(html, { scriptingEnabled: false });
  const body = elements(doc).find((node) => node.tagName === "body");
  const fragment = tree.createDocumentFragment();
  if (!body) return fragment;
  const leading = /^[\r\n\t ]+/.exec(html)?.[0];
  if (leading) tree.insertText(fragment, leading);
  for (const child of [...body.childNodes]) tree.appendChild(fragment, child);

  const stack = [...fragment.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (tree.isTextNode(node)) continue;
    if (!tree.isElementNode(node)) { tree.detachNode(node); continue; }
    const tag = node.tagName;
    if (node.childNodes.length && !node.childNodes.some(tree.isElementNode) && /<[/\w!]/.test(textContent(node)) && /<[/\w!]/.test(serialize(node))) {
      tree.detachNode(node);
      continue;
    }
    if (!tags.has(tag) && !slots.has(tag)) {
      if (!forbiddenContents.has(tag)) {
        const parent = node.parentNode!;
        for (const child of node.childNodes) tree.insertBefore(parent, child, node);
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
      }
      tree.detachNode(node);
      continue;
    }
    if (node.namespaceURI !== htmlNames.NS.HTML || attr(node, "is") !== undefined) {
      tree.detachNode(node);
      continue;
    }
    const original = new Map<string, string>();
    node.attrs = node.attrs.flatMap((entry) => {
      const name = entry.name;
      if (entry.namespace || forbiddenAttrs.has(name) || (!globals.has(name) && !perTag[tag]?.includes(name))) return [];
      let value = name === "value" ? entry.value : entry.value.trim();
      if (["id", "name", "for", "headers", "usemap"].includes(name)) original.set(name, value);
      if (urlAttrs.has(name)) {
        const resolved = name === "srcset" ? resolveSrcset(value, options.urls, options.remoteImages)
          : resolveAuthorUrl(value, tag === "a" && name === "href" ? "anchor" : "resource", options.urls, options.remoteImages);
        return resolved === null ? [] : [{ name, value: resolved }];
      }
      if (name === "id" || name === "name") value = prefixFragment(value);
      if (unsafeAttribute.test(value) || (value && !uriSafeAttrs.has(name) && !uriPattern.test(value.replace(attrWhitespace, "")))) return [];
      return [{ name, value }];
    });
    originals.set(node, original);
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
  return fragment;
}

/** DOM-free enforcement of the renderer's author policy. No generated HTML belongs here. */
export function sanitizeAuthorHtmlStatic(html: string, options: StaticAuthorOptions = {}): string {
  const originals: Originals = new WeakMap();
  const fragment = sanitizeTree(html, options, originals, new Set());
  updateFragments(fragment, originals);
  return serialize(fragment);
}

/** Assemble app nodes only after the containing author unit has been sanitized. */
export function renderStaticTree(rendered: RenderedHtml, options: StaticAuthorOptions = {}, preview = false): string {
  const originals: Originals = new WeakMap();
  const root = rendered.content ?? { kind: "app", parts: [rendered.html] };
  const strings: string[] = [];
  const pending = [root];
  while (pending.length) for (const part of pending.pop()!.parts) {
    if (typeof part === "string") strings.push(part.toLowerCase());
    else pending.push(part);
  }
  const source = strings.join("");
  let sequence = 0;
  function build(node: RenderNode): P.DocumentFragment {
    const slots = new Map<string, RenderNode>();
    const html = node.parts.map((part) => {
      if (typeof part === "string") return part;
      // Collision-free across all author and generated strings, without requiring
      // Web Crypto in JavaScriptCore. Slot names are never accepted from callers.
      let tag: string;
      do { tag = `simplemd-static-slot-${sequence++}`; } while (source.includes(tag));
      slots.set(tag, part);
      return node.kind === "author" ? `<${tag}></${tag}>` : `<!--${tag}-->`;
    }).join("");
    const fragment = node.kind === "author" ? sanitizeTree(html, options, originals, new Set(slots.keys())) : parseFragment(html);
    if (node.kind === "author") updateFragments(fragment, originals);
    const stack = [...fragment.childNodes].reverse();
    while (stack.length) {
      const item = stack.pop()!;
      const key = node.kind === "author" && tree.isElementNode(item) ? item.tagName : tree.isCommentNode(item) ? item.data : "";
      const child = slots.get(key);
      if (child) {
        for (const replacement of [...build(child).childNodes]) tree.insertBefore(item.parentNode!, replacement, item);
        tree.detachNode(item);
      } else if (tree.isElementNode(item)) for (let i = item.childNodes.length - 1; i >= 0; i--) stack.push(item.childNodes[i]!);
    }
    return fragment;
  }
  const fragment = build(root);
  updateFragments(fragment, originals);
  for (const node of elements(fragment)) {
    // Generated Markdown images use their own path, just as mountRenderedHtml
    // filters them after inserting generated nodes in the renderer.
    if (options.remoteImages === false && ["img", "source", "video"].includes(node.tagName)) {
      node.attrs = node.attrs.filter(({ name, value }) => !["src", "srcset"].includes(name) || !/^(?:https?:)?\/\//i.test(value));
    }
    if (!preview) continue;
    const classes = attr(node, "class")?.split(/\s+/) ?? [];
    if (node.tagName === "button" && classes.includes("copy-code")) tree.detachNode(node);
    if (node.tagName === "pre" && classes.includes("mermaid")) {
      node.attrs = [];
      const code = tree.createElement("code", htmlNames.NS.HTML, [{ name: "class", value: "language-mermaid" }]);
      for (const child of [...node.childNodes]) { tree.detachNode(child); tree.appendChild(code, child); }
      tree.appendChild(node, code);
    }
  }
  return serialize(fragment);
}

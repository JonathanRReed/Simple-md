import createDOMPurify from "dompurify";
import { authorPolicy, globalAttrs, perTag, prefixFragment } from "../shared/sanitizer-policy.js";
import { resolveAuthorUrl, resolveSrcset, resolveFragment, type UrlContext } from "../shared/url-resolver.js";
import type { RenderedHtml, RenderNode } from "../shared/render-tree.js";
import GithubSlugger from "github-slugger";
import { applyImageTheme, currentImageTheme } from "./document-images.js";

const purifier = createDOMPurify(window);
const originals = new WeakMap<Element, Map<string, string>>();
const generatedIds = new WeakMap<Element, Map<string, string>>();
const fragmentMaps = new WeakMap<Node, Map<string, string>>();
interface AuthorOptions { urls?: UrlContext; remoteImages?: boolean }

// One dedicated instance. The hook closes over one synchronous sanitize call.
export function sanitizeAuthorHtml(html: string, options: AuthorOptions = {}, slots: string[] = []): DocumentFragment {
  const resolved = new WeakMap<Node, Map<string, string>>();
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    const tag = node.nodeName.toLowerCase();
    const attr = data.attrName;
    if (!globalAttrs.includes(attr) && !perTag[tag]?.includes(attr)) {
      data.keepAttr = false;
      return;
    }
    if (attr === "id" || attr === "name" || attr === "for" || attr === "headers" || attr === "usemap") {
      const map = originals.get(node) ?? new Map<string, string>();
      map.set(attr, data.attrValue);
      originals.set(node, map);
    }
    if (["href", "src", "srcset", "longdesc", "cite", "action", "itemtype"].includes(attr)) {
      const value = attr === "srcset"
        ? resolveSrcset(data.attrValue, options.urls, options.remoteImages)
        : resolveAuthorUrl(data.attrValue, tag === "a" && attr === "href" ? "anchor" : "resource", options.urls, options.remoteImages);
      data.keepAttr = false;
      if (value !== null) {
        const attrs = resolved.get(node) ?? new Map<string, string>();
        attrs.set(attr, value);
        resolved.set(node, attrs);
      }
    }
  });
  purifier.addHook("afterSanitizeAttributes", (node) => {
    for (const [attr, value] of resolved.get(node) ?? []) node.setAttribute(attr, value);
  });
  try {
    // Slot tag names are minted here, never accepted from source or IPC.
    // They carry no attributes or content and disappear before DOM insertion.
    const fragment = purifier.sanitize(html, { ...authorPolicy, ADD_TAGS: slots });
    updateFragments(fragment);
    return fragment;
  } finally {
    purifier.removeAllHooks();
  }
}

function appFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  // App-owned path: only escaped Markdown and generated plugin HTML reach this sink.
  template.innerHTML = html;
  return template.content;
}

function buildNode(node: RenderNode, options: AuthorOptions): DocumentFragment {
  if (node.parts.every((part) => typeof part === "string")) {
    const html = node.parts.join("");
    return node.kind === "author" ? sanitizeAuthorHtml(html, options) : appFragment(html);
  }
  const slots = new Map<string, RenderNode>();
  const html = node.parts.map((part) => {
    if (typeof part === "string") return part;
    const tag = "simplemd-" + [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    slots.set(tag, part);
    return node.kind === "author" ? `<${tag}></${tag}>` : `<!--${tag}-->`;
  }).join("");
  const fragment = node.kind === "author" ? sanitizeAuthorHtml(html, options, [...slots.keys()]) : appFragment(html);
  if (node.kind === "author") {
    for (const [tag, child] of slots) {
      for (const slot of fragment.querySelectorAll(tag)) slot.replaceWith(buildNode(child, options));
    }
  } else {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_COMMENT);
    const comments: Comment[] = [];
    while (walker.nextNode()) if (walker.currentNode instanceof Comment) comments.push(walker.currentNode);
    for (const comment of comments) {
      const child = slots.get(comment.data);
      if (child) comment.replaceWith(buildNode(child, options));
    }
  }
  return fragment;
}

export function mountRenderedHtml(root: HTMLElement, rendered: RenderedHtml, remoteImages = true): void {
  const fragment = buildNode(rendered.content ?? { kind: "app", parts: [rendered.html] }, { urls: rendered.urls, remoteImages });
  if (!remoteImages) {
    // These nodes are generated Markdown, not author HTML. Local URLs have already
    // been minted by the shared resolver in the worker.
    for (const image of fragment.querySelectorAll("img, source, video")) {
      for (const attr of ["src", "srcset"]) if (/^(?:https?:)?\/\//i.test(image.getAttribute(attr) ?? "")) image.removeAttribute(attr);
    }
  }
  applyImageTheme(fragment, currentImageTheme());
  root.replaceChildren(fragment);
}

// Rebuild after block reuse, so duplicate IDs and references remain document-scoped.
export function updateFragments(root: HTMLElement | DocumentFragment): void {
  const slugger = new GithubSlugger();
  for (const heading of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (heading.closest("section.footnotes")) continue;
    const slug = slugger.slug(heading.textContent ?? "");
    if (!originals.get(heading)?.has("id")) {
      const id = "user-content-" + slug;
      heading.setAttribute("id", id);
      generatedIds.set(heading, new Map([["id", id]]));
    }
  }
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const element of root.querySelectorAll("[id], [name]")) {
    const original = originals.get(element);
    const generated = generatedIds.get(element) ?? new Map<string, string>();
    generatedIds.set(element, generated);
    for (const attr of ["id", "name"]) {
      const value = element.getAttribute(attr);
      if (value === null) continue;
      const source = original?.get(attr) ?? generated.get(attr) ?? value;
      let id = original?.has(attr) ? prefixFragment(source) : source;
      generated.set(attr, source);
      const base = id;
      let suffix = 1;
      while (used.has(id)) id = `${base}-${suffix++}`;
      used.add(id);
      if (!map.has(source)) map.set(source, id);
      if (!map.has(base)) map.set(base, id);
      element.setAttribute(attr, id);
    }
  }
  fragmentMaps.set(root, map);
  for (const element of root.querySelectorAll("[href], [for], [headers], [usemap]")) {
    const attrs = originals.get(element) ?? new Map<string, string>();
    originals.set(element, attrs);
    for (const attr of ["href", "for", "headers", "usemap"]) {
      const value = attrs.get(attr) ?? element.getAttribute(attr);
      if (value === null) continue;
      attrs.set(attr, value);
      if (attr === "href" || attr === "usemap") {
        if (value.startsWith("#")) {
          element.setAttribute(attr, resolveFragment(value, map));
        }
      } else element.setAttribute(attr, value.split(/\s+/).map((id) => map.get(id) ?? prefixFragment(id)).join(" "));
    }
  }
}

export function fragmentTarget(root: HTMLElement, fragment: string): Element | null {
  const mapped = resolveFragment(fragment, fragmentMaps.get(root)).slice(1);
  return root.querySelector(`[id="${CSS.escape(mapped)}"], [name="${CSS.escape(mapped)}"]`);
}

import { parse, serialize, defaultTreeAdapter as tree, html, type DefaultTreeAdapterTypes as P } from "parse5";

function images(root: P.ParentNode): P.Element[] {
  const found: P.Element[] = [];
  const stack = [...root.childNodes];
  while (stack.length) {
    const node = stack.pop()!;
    if (!tree.isElementNode(node)) continue;
    if (node.tagName === "img") found.push(node);
    for (const child of node.childNodes) stack.push(child);
  }
  return found;
}
const source = (node: P.Element) => node.attrs.find(a => a.name === "src")?.value;

/** Called on sanitized output only. No file access occurs in JavaScript. */
export function staticImageUrls(document: string | P.ParentNode): string[] {
  if (typeof document === "string" && !document.includes("<img")) return [];
  return [...new Set(images(typeof document === "string" ? parse(document) : document).map(source).filter((url): url is string => !!url?.startsWith("file:")))];
}

/** The native host supplies only bounded raster data it could read in its sandbox. */
export function embedStaticImages(document: string | P.ParentNode, resources: Readonly<Record<string, string>>): string {
  if (typeof document === "string" && !document.includes("<img")) return document;
  const parsed = typeof document === "string" ? parse(document) : document;
  for (const node of images(parsed)) {
    const url = source(node);
    const theme = /#gh-(dark|light)-mode-only$/.exec(url ?? "")?.[1];
    if (theme) node.attrs.push({ name: "data-simplemd-theme", value: theme });
    const data = url && Object.hasOwn(resources, url) ? resources[url] : undefined;
    if (data && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) {
      node.attrs = node.attrs.filter(a => a.name !== "srcset");
      node.attrs.find(a => a.name === "src")!.value = data;
    } else {
      const replacement = tree.createElement("span", html.NS.HTML, [{ name: "class", value: "image-unavailable" }]);
      const alt = node.attrs.find(a => a.name === "alt")?.value;
      tree.insertText(replacement, alt ? `Image unavailable: ${alt}` : "Image unavailable");
      tree.insertBefore(node.parentNode!, replacement, node);
      tree.detachNode(node);
    }
  }
  // Picture sources must not override the embedded fallback image in the display host.
  const stack: P.ParentNode[] = [parsed];
  while (stack.length) for (const node of stack.pop()!.childNodes) {
    if (!tree.isElementNode(node)) continue;
    if (node.tagName === "source") node.attrs = node.attrs.filter(a => a.name !== "srcset" && a.name !== "src");
    stack.push(node);
  }
  return serialize(parsed);
}

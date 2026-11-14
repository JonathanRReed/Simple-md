import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { resolveAuthorUrl } from "./url-resolver.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const children = (node: Node): Node[] => "childNodes" in node ? node.childNodes : [];
const attr = (node: Element, name: string) => node.attrs.find(attribute => attribute.name === name)?.value ?? "";
const rawText = (node: Node): string => "value" in node ? node.value : children(node).map(rawText).join("");
const escape = (text: string) => text.replace(/[\\`*_[\]<>]/g, "\\$&").replace(/(^|\n)([ \t]*)(#{1,6}|>|[-+]|\d+[.)])(?=\s)/g, "$1$2\\$3");
const url = (value: string) => {
  if (/[\x00-\x1f\x7f]/.test(value)) return "";
  const encoded = value.trim().replace(/[ ()<>]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  return resolveAuthorUrl(encoded, "anchor", { publicUrl: "https://clipboard.invalid/" }) ? encoded : "";
};
const blocks = new Set(["p", "div", "section", "article", "header", "footer", "main", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "ul", "ol", "blockquote", "table", "hr"]);
const trim = (text: string) => text.replace(/^\n+|\n+$/g, "");

/** Deliberate HTML paste. No DOM, fetching, execution, or editor dependencies. */
export function htmlToMarkdown(html: string): string {
  function inline(node: Node): string {
    if ("value" in node) return escape(node.value.replace(/\s+/g, " "));
    if (!element(node)) return children(node).map(inline).join("");
    const tag = node.tagName;
    if (tag === "br") return "  \n";
    if (tag === "input") return attr(node, "type").toLowerCase() === "checkbox" ? `[${node.attrs.some(attribute => attribute.name === "checked") ? "x" : " "}] ` : "";
    if (tag === "img") {
      const destination = url(attr(node, "src"));
      return destination ? `![${escape(attr(node, "alt"))}](${destination})` : escape(attr(node, "alt"));
    }
    if (tag === "code") {
      const text = rawText(node).replace(/\r\n?|\n/g, " ");
      if (!text) return "";
      const fence = "`".repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
      const pad = text.startsWith("`") || text.endsWith("`") || text.startsWith(" ") && text.endsWith(" ") ? " " : "";
      return fence + pad + text + pad + fence;
    }
    let content = flow(children(node));
    if (tag === "a") {
      const destination = url(attr(node, "href"));
      return destination && content.trim() ? `[${content.trim()}](${destination})` : content;
    }
    const style = attr(node, "style");
    const weight = /font-weight\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim() ?? "";
    const bold = tag === "strong" || tag === "b" && weight !== "normal" && weight !== "400" || weight === "bold" || Number(weight) >= 600;
    const italic = tag === "em" || tag === "i" || /font-style\s*:\s*italic/i.test(style);
    const strike = tag === "s" || tag === "del" || tag === "strike" || /text-decoration(?:-line)?\s*:[^;]*line-through/i.test(style);
    function wrap(mark: string) {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
      if (match[2]) content = match[1] + mark + match[2] + mark + match[3];
    }
    if (bold) wrap("**");
    if (italic) wrap("*");
    if (strike) wrap("~~");
    return content;
  }
  function list(node: Element): string {
    const ordered = node.tagName === "ol";
    let number = Number.parseInt(attr(node, "start")) || 1;
    return children(node).filter(element).filter(child => child.tagName === "li").map(item => {
      const explicit = Number.parseInt(attr(item, "value"));
      if (ordered && Number.isFinite(explicit)) number = explicit;
      const marker = ordered ? `${number++}. ` : "- ";
      const text = trim(flow(children(item))).trimStart();
      return marker + text.split("\n").map((line, i) => i ? " ".repeat(marker.length) + line : line).join("\n");
    }).join("\n");
  }
  function table(node: Element): string {
    const rows: Element[] = [];
    const visit = (parent: Node) => {
      for (const child of children(parent)) if (element(child)) {
        if (child.tagName === "tr") rows.push(child);
        else if (child.tagName !== "table") visit(child);
      }
    };
    visit(node);
    if (!rows.length) return "";
    const cells = rows.map(row => children(row).filter(element).filter(cell => cell.tagName === "th" || cell.tagName === "td"));
    const columns = Math.max(...cells.map(row => row.length));
    const line = (values: string[]) => "| " + Array.from({ length: columns }, (_, i) => values[i] ?? "").join(" | ") + " |";
    const lines = cells.map(row => line(row.map(cell => trim(flow(children(cell))).trim().replace(/\n+/g, " ").replace(/(?<!\\)\|/g, "\\|"))));
    lines.splice(1, 0, line((cells[0] ?? []).map((cell): string => {
      const align = (attr(cell, "align") || /text-align\s*:\s*(left|center|right)/i.exec(attr(cell, "style"))?.[1] || "").toLowerCase();
      return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
    }).concat(Array<string>(columns).fill("---")).slice(0, columns)));
    return lines.join("\n");
  }
  function render(node: Element): string {
    const tag = node.tagName;
    if (tag === "ul" || tag === "ol") return list(node);
    if (tag === "table") return table(node);
    if (tag === "hr") return "---";
    if (tag === "pre") {
      const code = children(node).find(child => element(child) && child.tagName === "code");
      const text = rawText(code ?? node).replace(/\r\n?/g, "\n").replace(/\n$/, "");
      const parent = node.parentNode;
      const classes = [code && element(code) ? attr(code, "class") : "", attr(node, "class"), parent && element(parent) ? attr(parent, "class") : ""].join(" ");
      const language = /(?:^|\s)(?:language-|lang-|highlight-(?:source|text)-)([\w+-]+)/.exec(classes)?.[1] ?? "";
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
      return `${fence}${language}\n${text}\n${fence}`;
    }
    const text = trim(flow(children(node))).trim();
    if (/^h[1-6]$/.test(tag)) return "#".repeat(Number(tag[1])) + " " + text;
    if (tag === "blockquote") return text.split("\n").map(line => line ? "> " + line : ">").join("\n");
    return text;
  }
  function flow(nodes: Node[]): string {
    let result = "";
    for (const node of nodes) {
      if (element(node) && blocks.has(node.tagName)) {
        const content = render(node);
        if (content) result = result.trimEnd() + (result.trim() ? "\n\n" : "") + content + "\n\n";
      } else {
        const content = inline(node);
        if (content.trim() || !result.endsWith("\n\n")) result += content;
      }
    }
    return result;
  }
  return trim(flow(children(parseFragment(html)))).trim();
}

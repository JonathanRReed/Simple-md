import { renderStaticHtml } from "../../../../src/shared/render-browser";
const inputs = {
  README: await Bun.file(new URL("../../../../../README.md", import.meta.url)).text(),
  math: "# Math\n\n$E = mc^2$\n\n$$\\frac{1}{2}$$\n",
  MDX: '---\ntitle: MDX\n---\nimport Widget from "./widget.js"\n\n# An inert MDX page\n\n<Widget onClick={() => alert("never")} />\n',
};
const rows = [];
for (const [name, source] of Object.entries(inputs)) {
  const html = await renderStaticHtml(source, `/project/${name}.${name === "MDX" ? "mdx" : "md"}`);
  rows.push({ name, source_bytes: Buffer.byteLength(source), html_bytes: Buffer.byteLength(html), fonts: (html.match(/data:font\/woff2/g) ?? []).length });
}
console.log(JSON.stringify(rows, null, 2));

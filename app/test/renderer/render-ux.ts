import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { createRenderCore } from "../../src/shared/render-core";
import { findMdxRanges } from "../../src/shared/mdx-ranges";
import { mountRenderedHtml, sanitizeAuthorHtml } from "../../src/renderer/author-html";
import { buildLiveDecorations, type LiveHost } from "../../src/renderer/live";
import { mdxSyntax } from "../../src/renderer/mdx-syntax";
import { createEditor } from "../../src/renderer/editor";
import { renderStaticTree } from "../../src/shared/sanitize-static";

async function runBatch({ css, staticCss, realPost }: { css: string; staticCss: string; realPost?: string }) {
  const failures: string[] = [];
  const check = (condition: unknown, name: string) => { if (!condition) failures.push(name); };
  const style = document.createElement("style");
  document.head.append(style);
  const core = createRenderCore({ urls: () => ({ baseUrl: "file:///project/docs/", rootUrl: "file:///project/" }) });
  const article = document.createElement("article"); article.className = "prose"; article.style.width = "732px"; document.body.append(article);
  let images = 0, liveHtml = 0, typing = 0;
  for (const stylesheet of [css, staticCss]) {
    style.textContent = stylesheet;
    for (const cls of stylesheet === css ? ["prose", "cm-image", "prose cm-rendered", "prose print"] : ["prose", "prose cm-rendered", "prose print"]) {
      const parent = document.createElement("div"); parent.className = cls; parent.style.width = "732px";
      const image = document.createElement("img"); image.className = cls === "cm-image" ? "cm-image" : "";
      image.width = 918; image.height = 1374;
      image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="918" height="1374"></svg>');
      parent.append(image); article.append(parent); await image.decode();
      check(Math.abs(image.getBoundingClientRect().height / image.getBoundingClientRect().width - 1374 / 918) < .001, `image ratio ${images}`);
      images++; parent.remove();
    }
  }
  style.textContent = css;
  const rendered = await core.renderMarkdown('---\ntitle: Trip\ndate: 2026-10-29\ntags: [one, two]\nfaq:\n  - question: Long question\n    answer: ' + 'a'.repeat(2000) + '\n---\n\n# Body\n\nText <Notice>Bring a hat</Notice>.', "/project/docs/post.mdx");
  mountRenderedHtml(article, rendered);
  const details = article.querySelector("details")!;
  check(!details.open, "frontmatter collapsed");
  check(details.querySelector("summary")?.textContent === "Trip · 2026-10-29 · one · two", "frontmatter summary");
  details.querySelector("summary")!.click(); check(details.open, "frontmatter expands on click");
  check(article.scrollWidth <= 733, "nested metadata does not widen article");
  check(getComputedStyle(details.querySelector(".frontmatter-value td")!).borderBottomWidth === "0px", "tags have no underline");
  const label = article.querySelector<HTMLElement>(".mdx-component > .mdx-label")!;
  check(label.parentElement!.textContent === "Notice Bring a hat", "component label separated in text");
  check(Number.parseFloat(getComputedStyle(label).marginInlineEnd) > 0, "component label spacing");
  check(renderStaticTree(rendered).includes("Notice</span> Bring a hat"), "static label separation");
  if (realPost) {
    const real = document.createElement("div"); article.append(real);
    mountRenderedHtml(real, await core.renderMarkdown(realPost, "/project/docs/BetterHelp.mdx"));
    const metadata = real.querySelector("details.frontmatter")!;
    check(!metadata.open, "BetterHelp metadata collapsed");
    metadata.querySelector("summary")!.click();
    check(metadata.open && article.scrollWidth <= 733, "BetterHelp expanded metadata contained");
    real.remove();
  }
  const blocked = sanitizeAuthorHtml('<a href="../../secret" title="safe">Blocked</a>', { urls: { baseUrl: "file:///project/docs/", rootUrl: "file:///project/" } });
  check(blocked.querySelector("a")?.getAttribute("title")?.startsWith("Link blocked"), "blocked author link reason");

  const cases = [
    '<img src="x.png">\n<img src="y.png">',
    '<figcaption>Caption</figcaption>',
    '<img src="x.png" width="918" height="1374" onerror="run()">',
    '<picture><source srcset="x.png 2x"><img src="x.png"></picture>',
    '<figure>\n<img src="x.png">\n<figcaption>Caption</figcaption>\n</figure>',
    '<a href="https://example.test"><img src="x.png"></a> <a href="https://example.test"><img src="y.png"></a>',
    'Before <img src="x.png"> after',
    '<figure>\n\n<img src="x.png">\n\n<figcaption>Caption</figcaption>\n\n</figure>',
  ];
  for (const mdx of [false, true]) for (const html of cases) {
    const source = html + "\n\nOutside";
    const host: LiveHost = { baseUrl: () => null, openLink() {}, renderFragment: text => core.renderFragment(text, "/project/docs") };
    let state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [markdown({ base: markdownLanguage }), ...(mdx ? [mdxSyntax(findMdxRanges(source))] : [])] });
    const deco = buildLiveDecorations(state, host);
    const widgets = [];
    for (let cursor = deco.iter(); cursor.value; cursor.next()) if (cursor.value.spec.widget?.kind?.startsWith("html")) widgets.push({ from: cursor.from, to: cursor.to, widget: cursor.value.spec.widget });
    check(widgets.length > 0, `live HTML rendered ${liveHtml}`);
    const parent = document.createElement("div"); document.body.append(parent);
    const view = new EditorView({ parent, state });
    for (const item of widgets) {
      const dom = item.widget.toDOM(view); parent.append(dom);
      for (let tries = 0; tries < 30 && !dom.childNodes.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
      if (item.widget.kind === "html-inline") check(!dom.querySelector("p"), `inline HTML has no paragraph wrapper ${liveHtml}`);
      check(html.startsWith("<figcaption>") ? dom.textContent === "Caption" : !!dom.querySelector("img"), `live image mounted ${liveHtml}`);
      check(!dom.querySelector("[onerror]"), `live HTML sanitized ${liveHtml}`);
      state = state.update({ selection: { anchor: item.from + 1 } }).state;
      const selected = buildLiveDecorations(state, host);
      let hidden = false;
      selected.between(item.from, item.to, (_a, _b, decoration) => { if (decoration.spec.widget?.kind?.startsWith("html")) hidden = true; });
      check(!hidden, `live HTML source revealed ${liveHtml}`);
      item.widget.destroy(dom);
    }
    check(state.doc.toString() === source, `live source unchanged ${liveHtml}`);
    view.destroy(); parent.remove(); liveHtml++;
  }

  for (const chunks of [["<", "Callout", ">", "text", "<", "/", "Callout", ">"], ["<Callout>", "text", "</", "Callout>"], ["<Callout>text</Callout>"], ["<div>", "<", "/", "div", ">"], ["<Callout>", "<Callout>", "</Callout>", "</Callout>"], ["<Callout>", "</", "Other>"]]) {
    const parent = document.createElement("div"); document.body.append(parent);
    const prefix = "\uFEFFunchanged\r\n\r\n";
    const editor = createEditor(parent, { text: prefix, mode: "source", host: { baseUrl: () => null, openLink() {}, renderFragment: async () => ({ html: "", urls: {} }) }, onChange() {}, onScroll() {}, onImages: async () => null });
    const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    for (const chunk of chunks) for (const character of chunk) {
      const { from, to } = view.state.selection.main;
      const insert = () => view.state.update({ changes: { from, to, insert: character }, selection: { anchor: from + character.length }, userEvent: "input.type" });
      if (!view.state.facet(EditorView.inputHandler).some(handler => handler(view, from, to, character, insert))) view.dispatch(insert());
    }
    check(editor.getText() === prefix + chunks.join(""), `closing tag typing ${typing}`);
    editor.destroy(); parent.remove(); typing++;
  }
  article.remove(); style.remove();
  return { failures, images, liveHtml, typing };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });

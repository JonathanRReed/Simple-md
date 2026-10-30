import { perfMark } from "./perf.js";
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import { makeDocumentId, makePaneId, makeRevisionId, type DocPayload, type Settings } from "../shared/types.js";
import { urlContext } from "./document-urls.js";
import { embedKatexFonts, embedLocalImages, EXPORT_LIGHT_THEME } from "./export-html.js";

perfMark("export-module-loaded");

export interface ExportSource { path: string | null; name: string; text: string }
export const printWaiters = new Map<number, (error?: string) => void>();

export function createExportJobs(here: string, getSettings: () => Settings, renderBlocks: typeof import("./render-client.js")["renderBlocks"]) {
  const INDEX = path.join(here, "renderer", "index.html");
  async function withPrintWindow<T>(source: ExportSource, use: (w: BrowserWindow, doc: DocPayload) => Promise<T>): Promise<T> {
    const rendered = await renderBlocks(source.text, source.path, /\.mdx$/i.test(source.name));
    const doc: DocPayload = { ...rendered, documentId: makeDocumentId(0), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: source.path, name: source.name, text: source.text, intent: "read", baseUrl: null };
    const pw = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(here, "preload.cjs"), sandbox: true, contextIsolation: true },
    });
    pw.webContents.on("will-navigate", (event) => event.preventDefault());
    pw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const id = pw.webContents.id;
    let timer: NodeJS.Timeout | undefined;
    try {
      await pw.loadFile(INDEX, { query: { print: "1" } });
      const ready = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The print preview did not finish loading.")), 15_000);
        pw.webContents.once("render-process-gone", () => reject(new Error("The print renderer stopped.")));
        pw.once("closed", () => reject(new Error("The print window closed.")));
        printWaiters.set(id, (error) => error ? reject(new Error(error)) : resolve());
      });
      pw.webContents.send("smd:print-doc", doc, getSettings());
      await ready;
      await pw.webContents.executeJavaScript(`document.title = ${JSON.stringify(doc.title)}`);
      pw.setTitle(doc.title);
      return await use(pw, doc);
    } finally {
      clearTimeout(timer);
      printWaiters.delete(id);
      if (!pw.isDestroyed()) pw.destroy();
    }
  }

  function makePdf(source: ExportSource): Promise<Buffer> {
    return withPrintWindow(source, (pw) =>
      pw.webContents.printToPDF({ printBackground: true, generateTaggedPDF: true, generateDocumentOutline: true, pageSize: "A4", margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } }),
    );
  }

  async function makeHtml(source: ExportSource): Promise<string> {
    const current = source;
    const { title, html } = await withPrintWindow(source, async (pw, doc) => {
      const sources: unknown = await pw.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#doc img'), image => image.currentSrc || image.getAttribute('src') || '')`);
      if (!Array.isArray(sources) || !sources.every((source): source is string => typeof source === "string")) throw new Error("Invalid export images.");
      const embedded = await embedLocalImages(sources, current.path ? urlContext(path.dirname(current.path)) : {});
      const html: unknown = await pw.webContents.executeJavaScript(`(() => {
        const clone = document.querySelector('#doc').cloneNode(true);
        const sources = ${JSON.stringify(embedded)};
        clone.querySelectorAll('img').forEach((image, index) => { image.src = sources[index]; image.removeAttribute('loading'); });
        // Static exports drop local links and failed image candidates to avoid leaking paths.
        clone.querySelectorAll('*').forEach(element => {
          for (const attribute of [...element.attributes]) {
            if (/^file:/i.test(attribute.value) || (attribute.name === 'srcset' && /(?:^|[,\\s])file:/i.test(attribute.value))) element.removeAttribute(attribute.name);
          }
        });
        return clone.innerHTML;
      })()`);
      if (typeof html !== "string") throw new Error("Invalid export document.");
      return { title: doc.title, html };
    });
    const dir = path.join(here, "renderer");
    const css = await fs.promises.readFile(path.join(dir, "style.css"), "utf8");
    const katex = await embedKatexFonts(
      await fs.promises.readFile(path.join(dir, "katex.min.css"), "utf8"),
      (relativePath) => fs.promises.readFile(path.join(dir, relativePath)),
    );
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<!doctype html>
  <html lang="en">
  <head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="generator" content="SimpleMD" />
  <title>${esc(title)}</title>
  <style>${css}</style>
  <style>${katex}</style>
  <style>
  ${EXPORT_LIGHT_THEME}
  /* Static-document overrides: no app chrome, no fixed layout. */
  html, body { height: auto; }
  body { display: block; overflow: visible; background: #fff; color: #242426; }
  .titlebar, #banner, #findbar, #picker, #toast, .copy-code, #edit, #empty, details.frontmatter { display: none !important; }
  #stage, .pane, .scroller { position: static; display: block; height: auto; overflow: visible; padding: 0; }
  .block { content-visibility: visible; }
  </style>
  </head>
  <body>
  <main id="stage"><section id="read" class="pane"><div class="scroller"><article class="prose">
  ${html}
  </article></div></section></main>
  </body>
  </html>
  `;
  }

  return { makeHtml, makePdf, withPrintWindow };
}

export { writeExportAtomic } from "./export-write.js";

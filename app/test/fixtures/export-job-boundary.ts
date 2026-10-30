import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../src/shared/types";
import { createRenderCore } from "../../src/shared/render-core";

// Native dialogs and PDF generation stay behind this boundary in the unit test.
class PrintWindow extends EventEmitter {
  static last: PrintWindow;
  title = "SimpleMD";
  pageTitle = "SimpleMD";
  destroyed = false;
  pdfOptions: unknown;
  webContents = Object.assign(new EventEmitter(), {
    id: 1,
    setWindowOpenHandler() {},
    send: () => printWaiters.get(1)?.(),
    executeJavaScript: async (script: string) => {
      const title = /document\.title = ("(?:[^"\\]|\\.)*")/.exec(script)?.[1];
      if (title) this.pageTitle = JSON.parse(title);
      else if (script.startsWith("Array.from")) return [];
      else return "<h1>Trip notes</h1>";
    },
    printToPDF: async (options: unknown) => {
      this.pdfOptions = options;
      expect(this.pageTitle).toBe("Trip notes");
      return Buffer.from("PDF boundary");
    },
  });
  constructor(readonly options: { show: boolean; title: string }) { super(); PrintWindow.last = this; }
  async loadFile() {}
  setTitle(title: string) { this.title = title; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}
mock.module("electron", () => ({ BrowserWindow: PrintWindow }));
const { createExportJobs, printWaiters } = await import("../../src/main/export-job");

test("print and HTML/PDF exports use the document title, with tagged PDF and outline options", async () => {
  const here = await fs.mkdtemp(path.join(os.tmpdir(), "smd-print-title-"));
  try {
    await fs.mkdir(path.join(here, "renderer"));
    await fs.writeFile(path.join(here, "renderer/style.css"), "");
    await fs.writeFile(path.join(here, "renderer/katex.min.css"), "");
    const core = createRenderCore();
    const jobs = createExportJobs(here, () => DEFAULT_SETTINGS, (text, file, mdx) => core.renderBlocks(text, file, false, mdx));
    const source = { path: "/notes/trip.md", name: "trip.md", text: "# Trip notes" };
    await jobs.withPrintWindow(source, async (_window, doc) => {
      expect(doc.title).toBe("Trip notes");
      expect(PrintWindow.last.pageTitle).toBe("Trip notes");
      expect(PrintWindow.last.title).toBe("Trip notes");
      expect(PrintWindow.last.options.show).toBe(false);
      expect(PrintWindow.last.options.title).toBe("Trip notes");
    });
    expect(PrintWindow.last.destroyed).toBe(true);
    const metadataSource = { ...source, text: '---\ntitle: Trip notes\n---\n\nBody without an H1.' };
    await jobs.withPrintWindow(metadataSource, async (_window, doc) => {
      expect(doc.title).toBe("Trip notes");
      expect(PrintWindow.last.pageTitle).toBe("Trip notes");
    });
    await jobs.makePdf(source);
    expect(PrintWindow.last.pdfOptions).toMatchObject({ generateTaggedPDF: true, generateDocumentOutline: true });
    const html = await jobs.makeHtml(source);
    expect(html).toContain("<title>Trip notes</title>");
    expect(html).not.toContain("<title>SimpleMD</title>");
    expect(printWaiters.size).toBe(0);
  } finally { await fs.rm(here, { recursive: true, force: true }); }
});

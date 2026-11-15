import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDocumentLink } from "../src/main/document-links";
import { makeDocumentId } from "../src/shared/types";

for (const route of [false, true]) for (const newTab of [false, true]) test(`${route ? "Astro" : "file"} links preserve ${newTab ? "new-tab" : "in-place"} intent and fragment`, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smd-links-")));
  const calls: unknown[][] = [];
  try {
    await fs.mkdir(path.join(root, "src/content/blog"), { recursive: true });
    await fs.mkdir(path.join(root, "public"));
    await fs.writeFile(path.join(root, "astro.config.mjs"), "");
    const destination = path.join(root, "destination.md"), routePath = path.join(root, "src/content/blog/prompts.mdx");
    await fs.writeFile(destination, "# install"); await fs.writeFile(routePath, "# install");
    const doc = { path: path.join(root, "post.mdx"), documentId: makeDocumentId(7) };
    expect(await openDocumentLink(route ? "/blog/prompts/#install" : "./destination.md#install", "read", newTab, doc, {
      external: async () => {}, open: async (...args) => { calls.push(args); return true; },
    })).toBe(true);
    expect(calls).toEqual([[route ? routePath : destination, "read", !newTab, doc.documentId, { kind: "heading", heading: "install" }]]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

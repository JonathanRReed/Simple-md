import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkLocation } from "../src/shared/link-location";

// Exercise the real main-process link function with only its I/O boundary replaced.
// Importing main.ts itself would start Electron, which this test must never do.
const main = await Bun.file(new URL('../src/main/main.ts', import.meta.url)).text();
const from = main.indexOf('async function openLink(');
const to = main.indexOf('\nasync function togglePanes', from);
const source = main.slice(from, to).replace(/async function openLink\([^\n]+\{/, 'async function openLink(href, intent = "edit", newTab = false, current = currentSession(), host = context()) {')
  .replace('    const { astroRouteFile } = await import("./document-urls.js");', '');
const factory = new Function('path', 'shell', 'currentSession', 'context', 'resolveAuthorUrl', 'urlContext', 'astroRouteFile', 'containedLocalFile', 'fileURLToPath', 'isMarkdown', 'openFile', 'linkLocation', `${source}; return openLink;`);
for (const route of [false, true]) for (const newTab of [false, true]) test(`${route ? 'Astro' : 'file'} links preserve ${newTab ? 'new-tab' : 'in-place'} intent and fragment`, async () => {
  const calls: unknown[][] = [];
  const doc = { path: '/repo/post.mdx', documentId: 7 };
  const host = {};
  const open = factory(path, {}, () => doc, () => host, () => 'file:///repo/destination.md#install', () => ({}), async () => route ? '/repo/prompts.mdx' : null,
    async () => '/repo/destination.md', fileURLToPath, () => true, async (...args: unknown[]) => { calls.push(args); return true; }, linkLocation);
  expect(await open(route ? '/blog/prompts/#install' : './destination.md#install', 'read', newTab)).toBe(true);
  expect(calls).toEqual([[route ? '/repo/prompts.mdx' : '/repo/destination.md', 'read', !newTab, 7, host, { kind: 'heading', heading: 'install' }]]);
});

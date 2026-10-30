import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { astroRouteFile, urlContext } from "../src/main/document-urls";
import { resolveAuthorUrl } from "../src/shared/url-resolver";

test("Astro routes resolve source collections and pages without executing configuration", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smd-astro-")));
  try {
    await fs.mkdir(path.join(root, "src/content/blog"), { recursive: true });
    await fs.mkdir(path.join(root, "src/pages/about"), { recursive: true });
    await fs.mkdir(path.join(root, "public"));
    await fs.writeFile(path.join(root, "astro.config.mjs"), 'throw new Error("Do not execute");');
    const post = path.join(root, "src/content/blog/prompts.mdx");
    const page = path.join(root, "src/pages/about/index.md");
    await fs.writeFile(post, "# Prompts"); await fs.writeFile(page, "# About");
    const context = urlContext(path.dirname(post));
    const resolve = (href: string) => astroRouteFile(resolveAuthorUrl(href, "anchor", context)!, context);
    expect(await resolve("/blog/prompts/")).toBe(post);
    expect(await resolve("/blog/prompts/#section")).toBe(post);
    expect(await resolve("/about/")).toBe(page);
    expect(await resolve("/blog/missing/")).toBeNull();
    expect(await astroRouteFile(pathToFileURL(path.join(root, "../outside")).href, context)).toBeNull();
    expect(await resolve("/blog/%2fetc/")).toBeNull();
    await fs.symlink(os.tmpdir(), path.join(root, "src/content/escape"));
    expect(await resolve("/escape/anything/")).toBeNull();
    await fs.unlink(path.join(root, "astro.config.mjs"));
    expect(await resolve("/blog/prompts/")).toBeNull();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

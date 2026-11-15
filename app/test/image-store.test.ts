import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { insertDocumentImage, saveDocumentImage } from "../src/main/image-store";
import { invalidateUrlContext } from "../src/main/document-urls";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function project(astro = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "simplemd-images-")); roots.push(root);
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, "src", "blog"), { recursive: true });
  if (astro) { await fs.mkdir(path.join(root, "public")); await fs.writeFile(path.join(root, "astro.config.mjs"), ""); }
  const doc = path.join(root, "src", "blog", "My post.mdx"); await fs.writeFile(doc, "unchanged\r\n");
  invalidateUrlContext(path.dirname(doc));
  return { root, doc };
}
test("pasted images use document names, relative folders and exclusive writes", async () => {
  const { doc } = await project();
  const images = await Promise.all(Array.from({ length: 5 }, (_, i) => saveDocumentImage(doc, new Uint8Array([i]), "PNG")));
  expect(new Set(images).size).toBe(5);
  for (const [i, image] of images.entries()) {
    expect(image).toMatch(/^assets\/My-post-[a-z0-9-]+\.png$/);
    expect(await fs.readFile(path.resolve(path.dirname(doc), image!))).toEqual(Buffer.from([i]));
  }
  const custom = await saveDocumentImage(doc, new Uint8Array([9]), "jpg", "media/photos");
  expect(custom).toStartWith("media/photos/");
  expect(await fs.readFile(doc, "utf8")).toBe("unchanged\r\n");
});
test("Astro public folder produces root-relative links", async () => {
  const { root, doc } = await project(true);
  const image = await saveDocumentImage(doc, new Uint8Array([1]), "png", "public/images/posts");
  expect(image).toStartWith("/images/posts/My-post-");
  expect(await fs.readFile(path.join(root, "public", image!))).toEqual(Buffer.from([1]));
});
test("picker links existing project images and copies outside images", async () => {
  const { root, doc } = await project(true);
  const local = path.join(root, "public", "a (b).png"); await fs.writeFile(local, "original");
  expect(await insertDocumentImage(doc, local)).toBe("/a%20%28b%29.png");
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "simplemd-external-image-")); roots.push(other);
  const external = path.join(other, "outside.png"); await fs.writeFile(external, "external");
  const image = await insertDocumentImage(doc, external, "public/blog");
  expect(image).toStartWith("/blog/My-post-");
  expect(await fs.readFile(external, "utf8")).toBe("external");
  expect(await fs.readFile(local, "utf8")).toBe("original");
});
test("unsafe folders and symlink escapes cannot create outside files", async () => {
  const { root, doc } = await project();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "simplemd-outside-")); roots.push(outside);
  for (const folder of ["../outside", outside, "a/../../b", "a\\b", "a//b", "", "a/./b"]) {
    await expect(saveDocumentImage(doc, new Uint8Array([1]), "png", folder)).rejects.toThrow();
  }
  await fs.symlink(outside, path.join(path.dirname(doc), "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(saveDocumentImage(doc, new Uint8Array([1]), "png", "escape/new")).rejects.toThrow("outside");
  expect(await fs.readdir(outside)).toEqual([]);
  expect(await saveDocumentImage(doc, new Uint8Array([1]), "exe")).toBeNull();
  expect((await fs.readdir(root)).sort()).toEqual([".git", "src"]);
});

test("bare public saves into the project public root", async () => {
  const { root, doc } = await project(true);
  const image = await saveDocumentImage(doc, new Uint8Array([7]), "png", "public");
  expect(image).toMatch(/^\/My-post-[a-z0-9-]+\.png$/);
  expect(await fs.readFile(path.join(root, "public", image!))).toEqual(Buffer.from([7]));
  expect(await fs.stat(path.join(path.dirname(doc), "public")).catch(() => null)).toBeNull();
});

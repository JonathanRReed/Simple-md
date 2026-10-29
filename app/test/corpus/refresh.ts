import { createHash } from "node:crypto";
import { mkdir, rm, rename } from "node:fs/promises";
import path from "node:path";
import documents from "./manifest.json";

const root = import.meta.dir;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const userAgent = "SimpleMD-public-corpus/1.0";

export function extractArticle(page: string): string {
  if (/"richTextTruncated":true/.test(page)) throw new Error("File page reports richTextTruncated=true");
  const article = /<article\b[^>]*class="[^"]*\bmarkdown-body\b[^"]*"[^>]*>[\s\S]*?<\/article>/g;
  const direct = page.match(article);
  if (direct?.length === 1) return direct[0]!;
  for (const script of page.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const find = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return;
      if ("richText" in value && typeof value.richText === "string") {
        const matches = value.richText.match(article);
        if (matches?.length === 1) return matches[0];
      }
      for (const child of Object.values(value)) {
        const found = find(child);
        if (found) return found;
      }
    };
    const found = find(JSON.parse(script[1]!));
    if (found) return found;
  }
  throw new Error(`Expected one markdown-body article, found ${direct?.length ?? 0}`);
}

async function get(url: string, accept = "text/html") {
  for (let attempt = 0; attempt < 3; attempt++) {
    await pause(1100);
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: accept },
      credentials: "omit",
      signal: AbortSignal.timeout(45_000),
    });
    if ((response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) && attempt < 2) {
      const retryAfter = response.headers.get("retry-after");
      const reset = response.headers.get("x-ratelimit-reset");
      const delay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000)
        : reset ? Number(reset) - Date.now() / 1000 : 60;
      await response.body?.cancel();
      if (!Number.isFinite(delay) || delay > 60) throw new Error(`Rate limited: ${url}. Retry after ${retryAfter ?? reset ?? "a later refresh"}.`);
      await pause(Math.max(1, delay) * 1000);
      continue;
    }
    const text = await response.text();
    return { status: response.status, text, contentType: response.headers.get("content-type") };
  }
  throw new Error(`Retry limit: ${url}`);
}

async function refresh() {
  const stage = path.join(root, ".refresh");
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, "snapshots"), { recursive: true });
  await mkdir(path.join(stage, "licenses"), { recursive: true });
  const receipts = [];
  const licenses = new Map<string, string[]>();
  let bytes = 0;
  for (const doc of documents) {
    if (!/^[\w-]+$/.test(doc.id) || !/^[a-f0-9]{40}$/.test(doc.commit) || !/^[\w.-]+\/[\w.-]+$/.test(doc.repo) || !/^[\w./-]+$/.test(doc.path)) {
      throw new Error(`Invalid pin: ${doc.id}`);
    }
    const rawUrl = `https://raw.githubusercontent.com/${doc.repo}/${doc.commit}/${doc.path}`;
    const pageUrl = `https://github.com/${doc.repo}/blob/${doc.commit}/${doc.path}`;
    const source = await get(rawUrl, "text/plain");
    if (source.status !== 200) throw new Error(`${rawUrl}: HTTP ${source.status}`);
    const page = await get(pageUrl);
    let reference: string;
    let method: "file-page" | "contents-api-html" = "file-page";
    let fallbackReason: string | null = null;
    try {
      if (page.status !== 200) {
        const title = /<title>([\s\S]*?)<\/title>/.exec(page.text)?.[1] ?? page.text.slice(0, 160);
        throw new Error(`HTTP ${page.status}: ${title}`);
      }
      reference = extractArticle(page.text);
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      console.warn(`${doc.id}: ${pageUrl}: ${fallbackReason}. Trying Contents API HTML.`);
      method = "contents-api-html";
      const api = await get(`https://api.github.com/repos/${doc.repo}/contents/${doc.path}?ref=${doc.commit}`, "application/vnd.github.html+json");
      if (api.status !== 200 || !api.contentType?.includes("html") || !/^\s*</.test(api.text)) {
        throw new Error(`${doc.id}: Contents API HTML failed: HTTP ${api.status}, ${api.contentType}`);
      }
      reference = api.text;
    }
    const licenseKey = `${doc.repo}/${doc.commit}`;
    if (!licenses.has(licenseKey)) {
      const names = [];
      for (const licensePath of doc.licensePaths) {
        const license = await get(`https://raw.githubusercontent.com/${doc.repo}/${doc.commit}/${licensePath}`, "text/plain");
        if (license.status !== 200) throw new Error(`${doc.repo}/${licensePath}: HTTP ${license.status}`);
        const name = `${doc.repo.replaceAll("/", "-")}-${licensePath.replaceAll("/", "-")}.txt`;
        await Bun.write(path.join(stage, "licenses", name), license.text);
        names.push(name);
        bytes += Buffer.byteLength(license.text);
      }
      licenses.set(licenseKey, names);
    }
    await Bun.write(path.join(stage, "snapshots", `${doc.id}.md`), source.text);
    await Bun.write(path.join(stage, "snapshots", `${doc.id}.html`), reference);
    bytes += Buffer.byteLength(source.text) + Buffer.byteLength(reference);
    receipts.push({ id: doc.id, fetchedAt: new Date().toISOString(), rawUrl, pageUrl, pageStatus: page.status,
      pageSha256: hash(page.text), method, fallbackReason, sourceSha256: hash(source.text), referenceSha256: hash(reference),
      licenseFiles: licenses.get(licenseKey) });
    console.log(`${doc.id}: ${method}, ${Buffer.byteLength(source.text)} + ${Buffer.byteLength(reference)} bytes`);
  }
  if (bytes > 5_000_000) throw new Error(`Corpus exceeds 5 MB: ${bytes} bytes`);
  const attribution = ["# Corpus attribution", "", "These are unmodified Markdown sources and extracted GitHub article HTML at the commits below. Images and other binary assets are not included. License texts and copyright notices are retained in `licenses/`. GitHub Docs text is CC BY 4.0. The snapshots reproduce its repository source, including Liquid and frontmatter, rather than the docs.github.com website.", "", "Run `bun test/corpus/refresh.ts` from `app/` to refresh the pins explicitly. Tests never fetch references. `receipts.json` records hashes, dates, HTTP status and any Contents API fallback. Updating a pin requires editing `manifest.json` first.", "", "| Document | Commit | License | Cases | Fetch |", "| --- | --- | --- | --- | --- |"];
  for (const [i, doc] of documents.entries()) {
    const receipt = receipts[i]!;
    const names = licenses.get(`${doc.repo}/${doc.commit}`)!;
    attribution.push(`| [${doc.repo}/${doc.path}](${receipt.pageUrl}) | ${doc.commit} | ${doc.license}: ${names.length ? names.map((name) => `[notice](licenses/${name})`).join(", ") : `[notice](snapshots/${doc.id}.md#license)`} | ${doc.covers.join(", ") || "plain Markdown control"} | ${receipt.method}${receipt.fallbackReason ? `: ${receipt.fallbackReason.replaceAll("|", "&#124;")}` : ""} |`);
  }
  // Publish only after every source, article and license succeeds. Failed fetches leave the checked-in references intact.
  for (const directory of ["snapshots", "licenses"]) {
    await rm(path.join(root, directory), { recursive: true, force: true });
    await rename(path.join(stage, directory), path.join(root, directory));
  }
  await Bun.write(path.join(root, "receipts.json"), JSON.stringify(receipts, null, 2) + "\n");
  await Bun.write(path.join(root, "ATTRIBUTION.md"), attribution.join("\n") + "\n");
  await rm(stage, { recursive: true, force: true });
  console.log(`Saved ${documents.length} documents and license notices: ${bytes} bytes.`);
}

if (import.meta.main) await refresh();

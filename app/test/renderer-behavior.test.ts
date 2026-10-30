import { expect, test } from "bun:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { renderMarkdown } from "../src/main/markdown";
import { runDom } from "./dom-runner";

test("renderer retains code DOM and protects lazy diagram generations", async () => {
  const rendered = await renderMarkdown("```ts\nconst answer = 42;\n```", "/tmp/renderer.md");
  const sources = [...Array.from({ length: 8 }, (_, i) => `graph LR\n A${i}-->B${i}`), "graph LR\n A[Current]-->B[Only current]"];
  const hashes = Object.fromEntries(sources.map(source => [source, [...createHash("sha256").update(source).digest()]]));
  expect(await runDom(path.join(import.meta.dir, "renderer/behavior.ts"), { rendered, hashes })).toEqual({ reusedCode: true, checkboxMapped: true, lazy: true, bounded: true, stale: true, svg: true, print: true, uniqueIds: true });
}, 60_000);

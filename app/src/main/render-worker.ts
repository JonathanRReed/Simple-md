import { calculateBlockChanges } from "./block-changes.js";
import type { BlockChanges } from "../shared/change-highlights.js";
import { IncrementalBlocks } from "./incremental-blocks.js";
import { blockDelta, type BlockDelta } from "../shared/block-delta.js";
import { BlockStreams } from "./block-stream.js";
import type { BlockUpdate } from "../shared/block-update.js";
import { type RenderedHtml } from "../shared/render-tree.js";
import type { MdxResult } from "../shared/render-core.js";
import { perfMark } from "./perf.js";
import { parentPort } from "node:worker_threads";
import { renderFragment, type RenderedBlocks } from "./markdown.js";

export type RenderCommand =
  | { kind: "changes"; before: string; text: string; filePath: string | null; baselineKey: string }
  | { kind: "blocks"; text: string; filePath: string | null; mdx?: boolean; known?: { key: string; fingerprint?: string }[] }
  | { kind: "fragment"; text: string; baseDir: string | undefined }
  | { kind: "mdx-ranges"; text: string }
  | { kind: "stream-start"; text: string; filePath: string | null }
  | { kind: "stream-next"; stream: number; text?: string }
  | { kind: "warmup" };

export type RenderRequest = RenderCommand & { id: number };

export type RenderResponse =
  | { id: number; kind: "changes"; value: BlockChanges }
  | { id: number; kind: "blocks"; value: RenderedBlocks }
  | { id: number; kind: "blocks-delta"; value: BlockDelta }
  | { id: number; kind: "fragment"; value: RenderedHtml }
  | { id: number; kind: "mdx-ranges"; value: MdxResult }
  | { id: number; kind: "stream-next"; value: BlockUpdate }
  | { id: number; kind: "warmup" }
  | { id: number; kind: "error"; message: string };

const port = parentPort;
if (!port) throw new Error("The render worker requires a parent port");

let incremental: { filePath: string | null; mdx: boolean; blocks: IncrementalBlocks } | undefined;
const streams = new BlockStreams((text, filePath, result) => {
  incremental = { filePath, mdx: /\.mdx$/i.test(filePath ?? ""), blocks: new IncrementalBlocks() };
  incremental.blocks.seed(text, result);
});

port.on("message", async (request: RenderRequest) => {
  perfMark("worker-receive", { requestId: request.id });
  try {
    let response: RenderResponse;
    switch (request.kind) {
      case "changes":
        response = { id: request.id, kind: "changes", value: await calculateBlockChanges(request.before, request.text, request.filePath, request.baselineKey) };
        break;
      case "stream-start":
        incremental = undefined;
        response = { id: request.id, kind: "blocks", value: await streams.start(request.text, request.filePath) };
        break;
      case "stream-next":
        if (request.text !== undefined) streams.resume(request.stream, request.text);
        response = { id: request.id, kind: "stream-next", value: await streams.next(request.stream) };
        break;
      case "blocks": {
        const mdx = request.mdx ?? /\.mdx$/i.test(request.filePath ?? "");
        if (!incremental || incremental.filePath !== request.filePath || incremental.mdx !== mdx) incremental = { filePath: request.filePath, mdx, blocks: new IncrementalBlocks() };
        const { result } = await incremental.blocks.render(request.text, request.filePath, mdx);
        const known = new Map(request.known?.map(block => [block.key, block.fingerprint]));
        const delta = blockDelta(result.blocks.filter(block => block.fingerprint !== undefined && known.get(block.key) === block.fingerprint), result);
        response = { id: request.id, kind: "blocks-delta", value: delta };
        break;
      }
      case "fragment":
        response = { id: request.id, kind: "fragment", value: await renderFragment(request.text, request.baseDir) };
        break;
      case "mdx-ranges": {
        const { findMdxRanges } = await import("../shared/mdx-ranges.js");
        const ranges = findMdxRanges(request.text);
        response = { id: request.id, kind: "mdx-ranges", value: { ranges: [...ranges], error: ranges.error } };
        break;
      }
      case "warmup":
        response = { id: request.id, kind: "warmup" };
        break;
      default: {
        const invalid: never = request;
        throw new Error(`Unknown render request: ${JSON.stringify(invalid)}`);
      }
    }
    perfMark("worker-serialize-start", { requestId: request.id });
    port.postMessage(response);
    perfMark("worker-serialize-end", { requestId: request.id });
  } catch (error) {
    port.postMessage({ id: request.id, kind: "error", message: error instanceof Error ? error.message : String(error) } satisfies RenderResponse);
  }
});

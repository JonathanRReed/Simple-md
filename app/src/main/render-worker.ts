import { BlockStreams } from "./block-stream.js";
import type { BlockUpdate } from "../shared/block-update.js";
import { type RenderedHtml } from "../shared/render-tree.js";
import { findMdxRanges } from "../shared/mdx-ranges.js";
import type { MdxResult } from "../shared/render-core.js";
import { perfMark } from "./perf.js";
import { parentPort } from "node:worker_threads";
import { renderBlocks, renderFragment, type RenderedBlocks } from "./markdown.js";

export type RenderCommand =
  | { kind: "blocks"; text: string; filePath: string | null }
  | { kind: "fragment"; text: string; baseDir: string | undefined }
  | { kind: "mdx-ranges"; text: string }
  | { kind: "stream-start"; text: string; filePath: string | null }
  | { kind: "stream-next"; stream: number }
  | { kind: "warmup" };

export type RenderRequest = RenderCommand & { id: number };

export type RenderResponse =
  | { id: number; kind: "blocks"; value: RenderedBlocks }
  | { id: number; kind: "fragment"; value: RenderedHtml }
  | { id: number; kind: "mdx-ranges"; value: MdxResult }
  | { id: number; kind: "stream-next"; value: BlockUpdate }
  | { id: number; kind: "warmup" }
  | { id: number; kind: "error"; message: string };

const port = parentPort;
if (!port) throw new Error("The render worker requires a parent port");

const streams = new BlockStreams();

port.on("message", async (request: RenderRequest) => {
  perfMark("worker-receive", { requestId: request.id });
  try {
    let response: RenderResponse;
    switch (request.kind) {
      case "stream-start":
        response = { id: request.id, kind: "blocks", value: await streams.start(request.text, request.filePath) };
        break;
      case "stream-next":
        response = { id: request.id, kind: "stream-next", value: await streams.next(request.stream) };
        break;
      case "blocks":
        response = { id: request.id, kind: "blocks", value: await renderBlocks(request.text, request.filePath) };
        break;
      case "fragment":
        response = { id: request.id, kind: "fragment", value: await renderFragment(request.text, request.baseDir) };
        break;
      case "mdx-ranges": {
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

import { IncrementalBlocks } from "./incremental-blocks.js";
import { blockDelta } from "../shared/block-delta.js";
import { BlockStreams } from "./block-stream.js";
import { renderFragment } from "./markdown.js";
import type { RenderRequest, RenderResponse } from "./render-worker.js";

let incremental: { filePath: string | null; blocks: IncrementalBlocks } | undefined;
const streams = new BlockStreams((text, filePath, result) => {
  incremental = { filePath, blocks: new IncrementalBlocks() };
  incremental.blocks.seed(text, result);
});

export async function renderCommand(request: Exclude<RenderRequest, { kind: "warmup" }>): Promise<RenderResponse> {
  let response: RenderResponse;
  switch (request.kind) {
    case "stream-start":
      incremental = undefined;
      response = { id: request.id, kind: "blocks", value: await streams.start(request.text, request.filePath) };
      break;
    case "stream-next":
      if (request.text !== undefined) streams.resume(request.stream, request.text);
      response = { id: request.id, kind: "stream-next", value: await streams.next(request.stream) };
      break;
    case "blocks": {
      if (!incremental || incremental.filePath !== request.filePath) incremental = { filePath: request.filePath, blocks: new IncrementalBlocks() };
      const { result } = await incremental.blocks.render(request.text, request.filePath);
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
    default: {
      const invalid: never = request;
      throw new Error(`Unknown render request: ${JSON.stringify(invalid)}`);
    }
  }
  return response;
}

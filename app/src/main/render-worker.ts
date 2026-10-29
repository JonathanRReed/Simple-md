import type { BlockDelta } from "../shared/block-delta.js";
import type { BlockUpdate } from "../shared/block-update.js";
import type { RenderedHtml } from "../shared/render-tree.js";
import type { MdxResult, RenderedBlocks } from "../shared/render-core.js";
import { perfMark } from "./perf.js";
import { parentPort } from "node:worker_threads";

export type RenderCommand =
  | { kind: "blocks"; text: string; filePath: string | null; known?: { key: string; fingerprint?: string }[] }
  | { kind: "fragment"; text: string; baseDir: string | undefined }
  | { kind: "mdx-ranges"; text: string }
  | { kind: "stream-start"; text: string; filePath: string | null }
  | { kind: "stream-next"; stream: number; text?: string }
  | { kind: "warmup" };

export type RenderRequest = RenderCommand & { id: number };

export type RenderResponse =
  | { id: number; kind: "blocks"; value: RenderedBlocks }
  | { id: number; kind: "blocks-delta"; value: BlockDelta }
  | { id: number; kind: "fragment"; value: RenderedHtml }
  | { id: number; kind: "mdx-ranges"; value: MdxResult }
  | { id: number; kind: "stream-next"; value: BlockUpdate }
  | { id: number; kind: "warmup" }
  | { id: number; kind: "error"; message: string };

const port = parentPort;
if (!port) throw new Error("The render worker requires a parent port");

port.on("message", async (request: RenderRequest) => {
  perfMark("worker-receive", { requestId: request.id });
  try {
    const response = request.kind === "warmup"
      ? { id: request.id, kind: "warmup" } satisfies RenderResponse
      : await (await import("./render-commands.js")).renderCommand(request);
    perfMark("worker-serialize-start", { requestId: request.id });
    port.postMessage(response);
    perfMark("worker-serialize-end", { requestId: request.id });
  } catch (error) {
    port.postMessage({ id: request.id, kind: "error", message: error instanceof Error ? error.message : String(error) } satisfies RenderResponse);
  }
});

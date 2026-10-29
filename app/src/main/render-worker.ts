import { type RenderedHtml } from "../shared/render-tree.js";
import { perfMark } from "./perf.js";
import { parentPort } from "node:worker_threads";
import { renderBlocks, renderFragment, type RenderedBlocks } from "./markdown.js";

export type RenderCommand =
  | { kind: "blocks"; text: string; filePath: string | null }
  | { kind: "fragment"; text: string; baseDir: string | undefined }
  | { kind: "warmup" };

export type RenderRequest = RenderCommand & { id: number };

export type RenderResponse =
  | { id: number; kind: "blocks"; value: RenderedBlocks }
  | { id: number; kind: "fragment"; value: RenderedHtml }
  | { id: number; kind: "warmup" }
  | { id: number; kind: "error"; message: string };

const port = parentPort;
if (!port) throw new Error("The render worker requires a parent port");

port.on("message", async (request: RenderRequest) => {
  perfMark("worker-receive", { requestId: request.id });
  try {
    let response: RenderResponse;
    switch (request.kind) {
      case "blocks":
        response = { id: request.id, kind: "blocks", value: await renderBlocks(request.text, request.filePath) };
        break;
      case "fragment":
        response = { id: request.id, kind: "fragment", value: await renderFragment(request.text, request.baseDir) };
        break;
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

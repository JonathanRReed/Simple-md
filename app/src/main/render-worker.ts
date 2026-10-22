import { parentPort } from "node:worker_threads";
import { renderBlocks, renderFragment, type RenderedBlocks } from "./markdown.js";

export type RenderCommand =
  | { kind: "blocks"; text: string; filePath: string | null }
  | { kind: "fragment"; text: string; baseDir: string | undefined }
  | { kind: "warmup" };

export type RenderRequest = RenderCommand & { id: number };

export type RenderResponse =
  | { id: number; kind: "blocks"; value: RenderedBlocks }
  | { id: number; kind: "fragment"; value: string }
  | { id: number; kind: "warmup" }
  | { id: number; kind: "error"; message: string };

const port = parentPort;
if (!port) throw new Error("The render worker requires a parent port");

port.on("message", async (request: RenderRequest) => {
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
    port.postMessage(response);
  } catch (error) {
    port.postMessage({ id: request.id, kind: "error", message: error instanceof Error ? error.message : String(error) } satisfies RenderResponse);
  }
});

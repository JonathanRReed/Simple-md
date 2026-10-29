import { perfMark } from "./perf.js";
import { Worker } from "node:worker_threads";
import type { RenderedBlocks } from "./markdown.js";
import type { RenderCommand, RenderRequest, RenderResponse } from "./render-worker.js";

type Pending = {
  request: RenderRequest;
  resolve: (response: RenderResponse | null) => void;
  reject: (error: Error) => void;
};

const MAX_PREFETCH_BYTES = 256 * 1024;

function isResponse(value: unknown): value is RenderResponse {
  if (typeof value !== "object" || value === null || !("id" in value) ||
      typeof value.id !== "number" || !Number.isSafeInteger(value.id) || !("kind" in value)) return false;
  if (value.kind === "warmup") return true;
  if (value.kind === "error") return "message" in value && typeof value.message === "string";
  if (!("value" in value)) return false;
  if (value.kind === "fragment") return typeof value.value === "string";
  if (value.kind !== "blocks" || typeof value.value !== "object" || value.value === null) return false;
  const result = value.value;
  return "title" in result && typeof result.title === "string" && "blocks" in result && Array.isArray(result.blocks) &&
    result.blocks.every((block: unknown) => typeof block === "object" && block !== null &&
      "key" in block && typeof block.key === "string" && "html" in block && typeof block.html === "string");
}

export class RenderClient {
  private worker: Worker | undefined;
  private sequence = 0;
  private active: Pending | undefined;
  private foreground: Pending[] = [];
  private speculative: Pending | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private termination: Promise<void> = Promise.resolve();

  constructor(
    private readonly workerUrl = new URL("./render-worker.mjs", import.meta.url),
    private readonly timeoutMs = 30_000,
  ) {}

  async renderBlocks(text: string, filePath: string | null): Promise<RenderedBlocks> {
    const response = await this.request({ kind: "blocks", text, filePath });
    if (response?.kind !== "blocks") throw new Error("Invalid block render response");
    return response.value;
  }

  async renderFragment(text: string, baseDir: string | undefined): Promise<string> {
    const response = await this.request({ kind: "fragment", text, baseDir });
    if (response?.kind !== "fragment") throw new Error("Invalid fragment render response");
    return response.value;
  }

  async warmUp(): Promise<void> {
    const response = await this.request({ kind: "warmup" });
    if (response?.kind !== "warmup") throw new Error("Invalid worker warmup response");
  }

  async prefetchBlocks(text: string, filePath: string | null): Promise<RenderedBlocks | null> {
    if (Buffer.byteLength(text) > MAX_PREFETCH_BYTES || this.foreground.length) return null;
    const response = await this.request({ kind: "blocks", text, filePath }, true);
    if (response === null) return null;
    if (response.kind !== "blocks") throw new Error("Invalid prefetch response");
    return response.value;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.fail(new Error("Renderer disposed"));
    return this.termination;
  }

  private request(request: RenderCommand, speculative = false): Promise<RenderResponse | null> {
    if (this.disposed) return Promise.reject(new Error("Renderer disposed"));
    return new Promise((resolve, reject) => {
      const pending: Pending = { request: { ...request, id: ++this.sequence }, resolve, reject };
      if (speculative) {
        this.speculative?.resolve(null);
        this.speculative = pending;
      } else {
        this.foreground.push(pending);
      }
      perfMark("worker-queue", { requestId: pending.request.id, command: request.kind });
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.active) return;
    const pending = this.foreground.shift() ?? this.speculative;
    if (!pending) {
      this.worker?.unref();
      return;
    }
    if (pending === this.speculative) this.speculative = undefined;
    this.active = pending;
    try {
      if (!this.worker) {
        const worker = new Worker(this.workerUrl);
        this.worker = worker;
        worker.on("message", (response: unknown) => {
          if (worker !== this.worker || !this.active) return;
          if (!isResponse(response) || response.id !== this.active.request.id) {
            this.fail(new Error("Render worker returned an invalid response"));
            return;
          }
          clearTimeout(this.timer);
          const active = this.active;
          this.active = undefined;
          if (response.kind === "error") active.reject(new Error(response.message));
          else active.resolve(response);
          this.dispatch();
        });
        worker.on("error", (error) => {
          if (worker === this.worker) this.fail(error instanceof Error ? error : new Error(String(error)));
        });
        worker.on("exit", (code) => {
          if (worker === this.worker) this.fail(new Error(`Render worker exited with code ${code}`));
        });
      }
      this.worker.ref();
      this.timer = setTimeout(() => this.fail(new Error("Render worker request timed out")), this.timeoutMs);
      perfMark("worker-dispatch", { requestId: pending.request.id });
      this.worker.postMessage(pending.request);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    clearTimeout(this.timer);
    const worker = this.worker;
    this.worker = undefined;
    this.active?.reject(error);
    this.active = undefined;
    for (const pending of this.foreground) pending.reject(error);
    this.foreground = [];
    this.speculative?.reject(error);
    this.speculative = undefined;
    if (worker) {
      this.termination = Promise.all([this.termination, worker.terminate()]).then(() => undefined);
      // Request failures may precede shutdown; dispose still observes termination errors.
      void this.termination.catch(() => {});
    }
  }
}

const client = new RenderClient();
export const renderBlocks = (text: string, filePath: string | null) => client.renderBlocks(text, filePath);
export const renderFragment = (text: string, baseDir: string | undefined) => client.renderFragment(text, baseDir);
export const prefetchBlocks = (text: string, filePath: string | null) => client.prefetchBlocks(text, filePath);
export const warmUp = () => client.warmUp();
export const disposeRenderer = (): Promise<void> => client.dispose();

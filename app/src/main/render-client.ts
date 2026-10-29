import { applyBlockUpdate } from "../shared/block-update.js";
import { cacheBudget } from "./cache-budget.js";
import { applyBlockDelta, isBlockDelta } from "../shared/block-delta.js";
import { isBlockUpdate, type BlockUpdate } from "../shared/block-update.js";
import { isRenderedBlock, isRenderedHtml, type RenderedHtml } from "../shared/render-tree.js";
import { isMdxResult } from "../shared/mdx-ranges.js";
import type { MdxResult } from "../shared/render-core.js";
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
  if (value.kind === "blocks-delta") return isBlockDelta(value.value);
  if (value.kind === "stream-next") return isBlockUpdate(value.value);
  if (value.kind === "mdx-ranges") return isMdxResult(value.value);
  if (value.kind === "fragment") return isRenderedHtml(value.value);
  if (value.kind !== "blocks" || typeof value.value !== "object" || value.value === null) return false;
  const result = value.value;
  return "title" in result && typeof result.title === "string" && "blocks" in result && Array.isArray(result.blocks) &&
    result.blocks.every(isRenderedBlock) && (!("mdx" in result) || result.mdx === undefined || isMdxResult(result.mdx));
}

export class RenderClient {
  private worker: Worker | undefined;
  private deferredSource: { stream: number; text: string } | undefined;
  private retainedBlocks: RenderedBlocks["blocks"] = [];
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

  async startBlocks(text: string, filePath: string | null): Promise<RenderedBlocks> {
    const deferred = text.length > 256 * 1024 && !/\.mdx$/i.test(filePath ?? "");
    const response = await this.request({ kind: "stream-start", text: deferred ? text.slice(0, 8192) : text, filePath });
    if (response?.kind !== "blocks") throw new Error("Invalid stream response");
    this.deferredSource = deferred && response.value.stream !== undefined ? { stream: response.value.stream, text } : undefined;
    return response.value;
  }

  async nextBlocks(stream: number): Promise<BlockUpdate> {
    const text = this.deferredSource?.stream === stream ? this.deferredSource.text : undefined;
    if (text !== undefined) this.deferredSource = undefined;
    const response = await this.request({ kind: "stream-next", stream, ...(text !== undefined ? { text } : {}) });
    if (response?.kind !== "stream-next") throw new Error("Invalid stream update");
    return response.value;
  }

  async renderFragment(text: string, baseDir: string | undefined): Promise<RenderedHtml> {
    const response = await this.request({ kind: "fragment", text, baseDir });
    if (response?.kind !== "fragment") throw new Error("Invalid fragment render response");
    return response.value;
  }

  async mdxRanges(text: string): Promise<MdxResult> {
    const response = await this.request({ kind: "mdx-ranges", text });
    if (response?.kind !== "mdx-ranges") throw new Error("Invalid MDX ranges response");
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
        const owner = cacheBudget.claimOwner();
        let worker: Worker;
        try { worker = new Worker(this.workerUrl, { workerData: { cacheBudget: owner.data } }); }
        catch (error) { owner.release(); throw error; }
        worker.once("exit", owner.release);
        this.worker = worker;
        worker.on("message", (response: unknown) => {
          if (worker !== this.worker || !this.active) return;
          if (!isResponse(response) || response.id !== this.active.request.id) {
            this.fail(new Error("Render worker returned an invalid response"));
            return;
          }
          let validResponse: RenderResponse = response;
          if (validResponse.kind === "blocks-delta") {
            try {
              const result = applyBlockDelta(this.retainedBlocks, validResponse.value);
              this.retainedBlocks = result.blocks;
              validResponse = { id: validResponse.id, kind: "blocks", value: result };
            } catch (error) {
              this.fail(error instanceof Error ? error : new Error(String(error)));
              return;
            }
          }
          if (this.active.request.kind === "stream-start" && validResponse.kind === "blocks") this.retainedBlocks = validResponse.value.blocks;
          if (validResponse.kind === "stream-next") this.retainedBlocks = applyBlockUpdate(this.retainedBlocks, validResponse.value);
          clearTimeout(this.timer);
          const active = this.active;
          this.active = undefined;
          if (validResponse.kind === "error") active.reject(new Error(validResponse.message));
          else active.resolve(validResponse);
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
      this.worker.postMessage(pending.request.kind === "blocks"
        ? { ...pending.request, known: this.retainedBlocks.map(({ key, fingerprint }) => ({ key, fingerprint })) }
        : pending.request);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    clearTimeout(this.timer);
    const worker = this.worker;
    this.worker = undefined;
    this.retainedBlocks = [];
    this.deferredSource = undefined;
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

export const mdxRanges = (text: string) => client.mdxRanges(text);

export const startBlocks = (text: string, filePath: string | null) => client.startBlocks(text, filePath);
export const nextBlocks = (stream: number) => client.nextBlocks(stream);

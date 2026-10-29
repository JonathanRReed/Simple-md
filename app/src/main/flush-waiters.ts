import type { FlushResult, RequestId } from "../shared/types.js";
export class FlushWaiters {
  private readonly pending = new Map<string, (result: FlushResult | null) => void>();
  private key(windowId: number, id: RequestId): string { return `${windowId}:${id}`; }
  set(windowId: number, id: RequestId, resolve: (result: FlushResult | null) => void): void { this.pending.set(this.key(windowId, id), resolve); }
  delete(windowId: number, id: RequestId): void { this.pending.delete(this.key(windowId, id)); }
  respond(windowId: number, id: RequestId, result: FlushResult): void { this.pending.get(this.key(windowId, id))?.(result); }
}

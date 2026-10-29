import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { DocumentId, DocumentLocation } from "../shared/types.js";

export const CLI_VERSION = 1;
export const FRAME_CAP = 1024 * 1024;
export const STDIN_CAP = 10 * 1024 * 1024;
export type Location = DocumentLocation;
export type CliRequest = { id: string } & (
  | { command: "open"; path: string; location: Location; wait: boolean }
  | { command: "stdin"; name: string; length: number; wait: boolean }
  | { command: "export"; path: string; output: string; format: "html" | "pdf"; overwrite: boolean }
);
function absolute(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || value.length > 32768) throw new Error("An absolute path is required.");
  return value;
}
export function location(line: unknown, heading: unknown): Location {
  if (line != null && heading != null) throw new Error("Choose a line or heading.");
  if (line != null) {
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || line > 0xffffffff) throw new Error("Invalid line number.");
    return { kind: "line", line };
  }
  if (heading != null) {
    if (typeof heading !== "string" || !heading.length || heading.length > 4096 || /[\0\r\n]/.test(heading)) throw new Error("Invalid heading slug.");
    return { kind: "heading", heading };
  }
  return { kind: "start" };
}
export function parseCliRequest(input: unknown, secret: string, bytes: number): CliRequest {
  if (bytes > FRAME_CAP || !input || typeof input !== "object" || !("version" in input) || input.version !== CLI_VERSION || !("id" in input) || typeof input.id !== "string" || !/^[\w-]{1,128}$/.test(input.id)) throw new Error("Invalid protocol version or request ID.");
  if (!("secret" in input) || typeof input.secret !== "string" || !/^[a-f0-9]{64}$/.test(input.secret) || !/^[a-f0-9]{64}$/.test(secret) || !timingSafeEqual(Buffer.from(input.secret), Buffer.from(secret))) throw new Error("Unauthorized request.");
  const id = input.id;
  if (!("command" in input)) throw new Error("Missing command.");
  switch (input.command) {
    case "open": {
      if (!("path" in input) || !("wait" in input) || typeof input.wait !== "boolean") throw new Error("Invalid open request.");
      return { id, command: "open", path: absolute(input.path), wait: input.wait, location: location("line" in input ? input.line : null, "heading" in input ? input.heading : null) };
    }
    case "stdin": {
      if (!("name" in input) || typeof input.name !== "string" || !input.name.length || input.name.length > 255 || /[/\\\0\r\n]/.test(input.name) || !("length" in input) || typeof input.length !== "number" || !Number.isSafeInteger(input.length) || input.length < 0 || input.length > STDIN_CAP || !("wait" in input) || typeof input.wait !== "boolean") throw new Error("Invalid stdin request.");
      return { id, command: "stdin", name: input.name, length: input.length, wait: input.wait };
    }
    case "export": {
      if (!("path" in input) || !("output" in input) || !("format" in input) || (input.format !== "html" && input.format !== "pdf") || !("overwrite" in input) || typeof input.overwrite !== "boolean") throw new Error("Invalid export request.");
      return { id, command: "export", path: absolute(input.path), output: absolute(input.output), format: input.format, overwrite: input.overwrite };
    }
    default: throw new Error("Unknown command.");
  }
}
export function parseOpenUrl(value: string): { path: string; location: Location } {
  const url = new URL(value);
  if (url.protocol !== "simplemd:" || url.hostname !== "open" || (url.pathname !== "" && url.pathname !== "/") || url.username || url.password || url.port || url.hash) throw new Error("Only simplemd://open is supported.");
  const params = url.searchParams;
  for (const key of params.keys()) if (!["path", "line", "heading"].includes(key) || params.getAll(key).length !== 1) throw new Error("Invalid URL parameters.");
  const number = params.get("line");
  if (number !== null && !/^[1-9]\d*$/.test(number)) throw new Error("Invalid line number.");
  return { path: absolute(params.get("path")), location: location(number === null ? null : Number(number), params.get("heading")) };
}
export function frame(bytes: Buffer): Buffer {
  if (!bytes.length || bytes.length > FRAME_CAP) throw new Error("Invalid response frame.");
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]);
}
// Allocate once per declared frame, after checking its cap. A callback can change
// the next cap only after an authenticated stdin header has been parsed.
export class FrameReader {
  cap = FRAME_CAP;
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private payload: Buffer | undefined;
  private used = 0;
  push(chunk: Buffer, consume: (bytes: Buffer) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + count); this.headerUsed += count; offset += count;
        if (this.headerUsed < 4) continue;
        const length = this.header.readUInt32BE();
        if (!length || length > this.cap) throw new Error("Frame exceeds limit.");
        this.payload = Buffer.allocUnsafe(length); this.used = 0;
      }
      const count = Math.min(this.payload.length - this.used, chunk.length - offset);
      chunk.copy(this.payload, this.used, offset, offset + count); this.used += count; offset += count;
      if (this.used === this.payload.length) {
        const payload = this.payload; this.payload = undefined; this.headerUsed = 0; consume(payload);
      }
    }
  }
}
export class DocumentWaiters {
  private readonly tokens = new Map<DocumentId, Set<() => void>>();
  add(id: DocumentId, closed: () => void): () => void {
    const callbacks = this.tokens.get(id) ?? new Set<() => void>(); this.tokens.set(id, callbacks); callbacks.add(closed);
    return () => { callbacks.delete(closed); if (!callbacks.size) this.tokens.delete(id); };
  }
  closed(id: DocumentId): void {
    const callbacks = this.tokens.get(id); this.tokens.delete(id);
    for (const callback of callbacks ?? []) callback();
  }
  clear(): void { this.tokens.clear(); }
  get size(): number { return [...this.tokens.values()].reduce((n, callbacks) => n + callbacks.size, 0); }
}

import fs from "node:fs";
import path from "node:path";
import { isMarkdown } from "./files.js";
import { opensInSource } from "../shared/open-policy.js";
export function fileArgs(argv: readonly string[], cwd = process.cwd(), isFile: (file: string) => boolean = file => { try { return fs.statSync(file).isFile(); } catch { return false; } }): string[] {
  let literal = false;
  return argv.slice(1).flatMap(arg => {
    if (arg === "--") { literal = true; return []; }
    if (!literal && arg.startsWith("-") || arg.startsWith("simplemd:")) return [];
    const file = path.resolve(cwd, arg);
    return (isMarkdown(arg) || opensInSource(arg)) && isFile(file) ? [file] : [];
  });
}
/** Events arriving during drain join its tail. Each request runs in arrival order. */
export class OpenRequests {
  private pending: string[] = [];
  private ready = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly open: (file: string) => Promise<unknown>, private readonly failed: (error: unknown) => void = console.error) {}
  add(files: readonly string[]): void {
    for (const file of files) {
      if (!this.ready) this.pending.push(file);
      else this.enqueue(file);
    }
  }
  private enqueue(file: string): void { this.tail = this.tail.then(async () => { await this.open(file); }).catch(this.failed); }
  async start(): Promise<void> {
    this.ready = true;
    for (const file of this.pending.splice(0)) this.enqueue(file);
    while (true) { const tail = this.tail; await tail; if (tail === this.tail) return; }
  }
  get size(): number { return this.pending.length; }
}

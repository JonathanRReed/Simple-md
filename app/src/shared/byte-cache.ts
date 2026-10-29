/** Retained cache bytes, shared by all cache namespaces and optionally worker threads. */
export class CacheBudget {
  private readonly ledger: Int32Array<SharedArrayBuffer> | undefined;
  private localBytes = 0;
  private readonly owners = new Set<number>();
  private readonly entries = new Map<object, { bytes: number; evict: () => void }>();

  constructor(readonly maxBytes = 16 * 1024 * 1024, buffer?: SharedArrayBuffer, private readonly owner = 1) {
    this.ledger = typeof SharedArrayBuffer === "function" ? new Int32Array(buffer ?? new SharedArrayBuffer(128)) : undefined;
  }

  get buffer(): SharedArrayBuffer {
    if (!this.ledger) throw new Error("Shared cache memory is unavailable");
    return this.ledger.buffer;
  }
  get bytes(): number { return this.ledger ? Atomics.load(this.ledger, 0) : this.localBytes; }

  claimOwner(): { data: { buffer: SharedArrayBuffer; owner: number }; release: () => void } {
    const ledger = this.ledger;
    if (!ledger) throw new Error("Shared cache memory is unavailable");
    let owner = 2;
    while (this.owners.has(owner) && owner < ledger.length) owner++;
    if (owner >= ledger.length) throw new Error("Too many cache owners");
    this.owners.add(owner);
    let released = false;
    return { data: { buffer: this.buffer, owner }, release: () => {
      if (released) return;
      released = true;
      const bytes = Atomics.exchange(ledger, owner, 0);
      Atomics.sub(ledger, 0, bytes);
      this.owners.delete(owner);
    } };
  }

  touch(token: object): void {
    const entry = this.entries.get(token);
    if (entry) { this.entries.delete(token); this.entries.set(token, entry); }
  }

  release(token: object): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    if (this.ledger) {
      Atomics.sub(this.ledger, this.owner, entry.bytes);
      Atomics.sub(this.ledger, 0, entry.bytes);
    } else this.localBytes -= entry.bytes;
  }

  reserve(token: object, bytes: number, evict: () => void): boolean {
    this.release(token);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) return false;
    for (;;) {
      const used = this.bytes;
      if (used + bytes <= this.maxBytes) {
        if (this.ledger) {
          if (Atomics.compareExchange(this.ledger, 0, used, used + bytes) !== used) continue;
          Atomics.add(this.ledger, this.owner, bytes);
        } else this.localBytes += bytes;
        this.entries.set(token, { bytes, evict });
        return true;
      }
      const oldest = this.entries.entries().next().value;
      if (!oldest) return false;
      this.release(oldest[0]);
      oldest[1].evict();
    }
  }
}

export class ByteCache<T> {
  private readonly entries = new Map<string, { value: T; token: object }>();
  constructor(private readonly budget: CacheBudget) {}
  get size(): number { return this.entries.size; }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry) this.budget.touch(entry.token);
    return entry?.value;
  }
  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    bytes += 256;
    const token = {};
    if (this.budget.reserve(token, bytes, () => this.entries.delete(key))) this.entries.set(key, { value, token });
  }
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.budget.release(entry.token);
    this.entries.delete(key);
  }
  clear(): void { for (const key of this.entries.keys()) this.delete(key); }
}

export interface PeekRequest {
  readonly paths: string[];
  readonly origin?: string;
  validate(): Promise<boolean>;
  replay(): void;
  complete(): void;
}

type PeekCommand = { cmd: "validate-peek" | "replay-space" | "complete-peek"; requestId: number };
type Validation = { promise: Promise<boolean>; resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> };
type Pending = { open: boolean; completed: boolean; replayed: boolean; validation?: Validation };

export class PeekSession {
  private alive = true;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly send: (command: PeekCommand) => boolean, private readonly timeoutMs = 200) {}

  request(requestId: number, paths: string[], origin?: string): PeekRequest | null {
    if (!this.alive || this.pending.has(requestId)) return null;
    const state: Pending = { open: true, completed: false, replayed: false };
    this.pending.set(requestId, state);
    return {
      paths, origin,
      validate: () => this.validate(requestId, state),
      replay: () => {
        if (!this.alive || state.completed || state.replayed) return;
        state.replayed = true;
        this.send({ cmd: "replay-space", requestId });
      },
      complete: () => {
        if (state.completed) return;
        state.completed = true;
        this.finishValidation(state, false);
        this.pending.delete(requestId);
        if (this.alive) this.send({ cmd: "complete-peek", requestId });
      },
    };
  }

  validation(requestId: number, valid: boolean): void {
    const state = this.pending.get(requestId);
    if (!this.alive || !state?.validation) return;
    state.open = state.open && valid;
    this.finishValidation(state, state.open);
  }

  close(): void {
    this.alive = false;
    for (const state of this.pending.values()) {
      state.open = false;
      this.finishValidation(state, false);
    }
    this.pending.clear();
  }

  private validate(requestId: number, state: Pending): Promise<boolean> {
    if (!this.alive || state.completed || !state.open) return Promise.resolve(false);
    if (state.validation) return state.validation.promise;
    let resolve: (value: boolean) => void = () => {};
    const promise = new Promise<boolean>((done) => { resolve = done; });
    const timer = setTimeout(() => {
      state.open = false;
      this.finishValidation(state, false);
    }, this.timeoutMs);
    state.validation = { promise, resolve, timer };
    if (!this.send({ cmd: "validate-peek", requestId })) {
      state.open = false;
      this.finishValidation(state, false);
    }
    return promise;
  }

  private finishValidation(state: Pending, value: boolean): void {
    if (!state.validation) return;
    const validation = state.validation;
    state.validation = undefined;
    clearTimeout(validation.timer);
    validation.resolve(value);
  }
}

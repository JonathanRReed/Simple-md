/** Settlement freezes documents; only the updater's actual quit runs app cleanup. */
export class UpdateInstall {
  active = false;
  constructor(private readonly actions: { settle(): Promise<boolean>; release(): void; failed(error: unknown): void }) {}
  async start(launch: (failed: (error: unknown) => void) => void | Promise<void>): Promise<void> {
    if (this.active) return;
    this.active = true;
    const fail = (error: unknown) => {
      if (!this.active) return;
      this.active = false; this.actions.release(); this.actions.failed(error);
    };
    try {
      if (!await this.actions.settle()) { this.active = false; this.actions.release(); return; }
      if (this.active) await launch(fail);
    } catch (error) { fail(error); }
  }
  failed(error: unknown): void {
    if (!this.active) return;
    this.active = false; this.actions.release(); this.actions.failed(error);
  }
}

export async function installMacUpdate(actions: { cleanup(): Promise<void>; install(): void; exit(): void }, defer = (exit: () => void, delay: number) => { setTimeout(exit, delay).unref(); }): Promise<void> {
  await actions.cleanup();
  actions.install();
  defer(actions.exit, 10_000);
}

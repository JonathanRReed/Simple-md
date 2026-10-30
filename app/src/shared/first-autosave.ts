/** Files opened for reading need a deliberate edit before their first automatic write. */
export class FirstAutosave {
  allowed: boolean;
  private changed = 0;
  private previous: string;
  private lastEdit: number | undefined;
  constructor(text: string, openedForReading: boolean) {
    this.previous = text;
    this.allowed = !openedForReading;
  }
  edit(text: string, now = Date.now()): void {
    if (text === this.previous) return;
    if (!this.allowed) {
      let start = 0, oldEnd = this.previous.length, newEnd = text.length;
      while (start < oldEnd && start < newEnd && this.previous[start] === text[start]) start++;
      while (oldEnd > start && newEnd > start && this.previous[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
      this.changed += Math.max(oldEnd - start, newEnd - start);
      this.allowed = this.changed >= 12 || this.lastEdit !== undefined && now - this.lastEdit >= 1500;
      this.lastEdit = now;
    }
    this.previous = text;
  }
  baseline(text: string): void { this.previous = text; this.changed = 0; this.lastEdit = undefined; }
  confirm(): void { this.allowed = true; }
}

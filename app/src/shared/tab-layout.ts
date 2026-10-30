import { makePaneId, type DocumentId, type PaneId } from "./types.js";

export interface PaneSlot { paneId: PaneId; documentId: DocumentId }
export interface TabLayoutState {
  tabs: DocumentId[];
  pinned?: DocumentId[];
  panes: [] | [PaneSlot] | [PaneSlot, PaneSlot];
  activePane: PaneId;
  axis: "horizontal" | "vertical";
}

/** Window membership and visible documents. A document has at most one view. */
export class TabLayout {
  readonly state: TabLayoutState = { tabs: [], panes: [], activePane: makePaneId(0), axis: "horizontal" };
  private nextPane = 0;
  get active(): PaneSlot | undefined { return this.state.panes.find(p => p.paneId === this.state.activePane); }
  has(id: DocumentId): boolean { return this.state.tabs.includes(id); }
  isPinned(id: DocumentId): boolean { return this.state.pinned?.includes(id) ?? false; }
  pin(id: DocumentId, pinned: boolean, before?: DocumentId): void {
    if (!this.has(id) || before === id) return;
    const pins = new Set(this.state.pinned);
    if (pinned) pins.add(id); else pins.delete(id);
    const ordered = this.state.tabs.filter(tab => tab !== id);
    const target = before === undefined ? -1 : ordered.indexOf(before);
    const boundary = ordered.filter(tab => pins.has(tab)).length;
    ordered.splice(target >= 0 && before !== undefined && pins.has(before) === pinned ? target : pinned ? boundary : ordered.length, 0, id);
    this.state.tabs = [...ordered.filter(tab => pins.has(tab)), ...ordered.filter(tab => !pins.has(tab))];
    this.state.pinned = this.state.tabs.filter(tab => pins.has(tab));
  }
  /** A normal close moves focus away from a pinned document without removing it. */
  leavePinned(id: DocumentId): boolean {
    if (!this.isPinned(id)) return false;
    if (this.active?.documentId !== id) return true;
    const index = this.state.tabs.indexOf(id);
    const next = this.state.tabs[(index + 1) % this.state.tabs.length];
    if (next !== undefined && next !== id) this.activate(next);
    return true;
  }
  add(id: DocumentId): void {
    if (!this.has(id)) this.state.tabs.push(id);
    this.activate(id);
  }
  activate(id: DocumentId): void {
    if (!this.has(id)) return;
    const visible = this.state.panes.find(p => p.documentId === id);
    if (visible) this.state.activePane = visible.paneId;
    else if (this.active) this.active.documentId = id;
    else {
      const slot = { paneId: makePaneId(this.nextPane++), documentId: id };
      this.state.panes = [slot];
      this.state.activePane = slot.paneId;
    }
  }
  replace(previous: DocumentId, next: DocumentId): void {
    const index = this.state.tabs.indexOf(previous);
    if (index < 0 || this.has(next)) return;
    this.state.tabs[index] = next;
    if (this.state.pinned) this.state.pinned = this.state.pinned.filter(id => id !== previous);
    const pane = this.state.panes.find(p => p.documentId === previous);
    if (pane) pane.documentId = next;
  }
  cycle(delta: number): void {
    const active = this.active?.documentId;
    const index = active === undefined ? -1 : this.state.tabs.indexOf(active);
    const id = this.state.tabs[(index + delta + this.state.tabs.length) % this.state.tabs.length];
    if (id !== undefined) this.activate(id);
  }
  focus(id: PaneId): void { if (this.state.panes.some(p => p.paneId === id)) this.state.activePane = id; }
  focusOther(): void {
    const other = this.state.panes.find(p => p.paneId !== this.state.activePane);
    if (other) this.state.activePane = other.paneId;
  }
  split(axis: TabLayoutState["axis"], companion: DocumentId): void {
    this.state.axis = axis;
    if (this.state.panes.length === 2) {
      if (companion === this.active?.documentId) this.state.panes = [this.active];
      return;
    }
    if (!this.active || companion === this.active.documentId || !this.has(companion)) return;
    this.state.panes = [this.active, { paneId: makePaneId(this.nextPane++), documentId: companion }];
  }
  remove(id: DocumentId): void {
    const index = this.state.tabs.indexOf(id);
    if (index < 0) return;
    this.state.tabs.splice(index, 1);
    if (this.state.pinned) this.state.pinned = this.state.pinned.filter(tab => tab !== id);
    const slot = this.state.panes.find(p => p.documentId === id);
    if (!slot) return;
    const next = this.state.tabs.filter(tab => !this.state.panes.some(p => p.documentId === tab));
    const replacement = next[Math.min(index, next.length - 1)];
    if (replacement !== undefined) slot.documentId = replacement;
    else {
      const remaining = this.state.panes.find(p => p !== slot);
      this.state.panes = remaining ? [remaining] : [];
      if (remaining) this.state.activePane = remaining.paneId;
    }
  }
}

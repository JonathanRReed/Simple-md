/** All ranges use zero-based, end-exclusive source lines, like RenderedBlock. */
export interface BlockChanges {
  changed: [number, number][];
  deleted: number[];
}
export type ChangeBaseline = { kind: "watch" | "head"; text: string };
export type GitChangesStatus = { available: true; active: boolean } | { available: false; reason: string };

export function isBlockChanges(value: unknown): value is BlockChanges {
  const line = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  return typeof value === "object" && value !== null && "changed" in value && Array.isArray(value.changed) &&
    value.changed.every(r => Array.isArray(r) && r.length === 2 && line(r[0]) && line(r[1]) && r[1] >= r[0]) &&
    "deleted" in value && Array.isArray(value.deleted) && value.deleted.every(line);
}

export interface HighlightState {
  kind: ChangeBaseline["kind"] | null;
  generation: number;
  changes: BlockChanges;
}

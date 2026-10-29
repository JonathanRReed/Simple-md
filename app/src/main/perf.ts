// Opt-in diagnostics only. The parent timestamps receipt of each marker on its own clock.
export function perfMark(marker: string, detail: object = {}): void {
  if (process.env.SMD_PERF === "1") console.log(`smd-perf ${JSON.stringify({ kind: "marker", marker, at: performance.now(), ...detail })}`);
}

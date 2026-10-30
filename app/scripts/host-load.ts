import { execFileSync } from "node:child_process";

/** Optional admission control for GUI checks on the owner's shared Mac. */
export async function waitForGuiLoad(): Promise<void> {
  const configured = process.env.SMD_MAX_GUI_LOAD;
  if (configured === undefined) return;
  const maximum = Number(configured);
  if (!Number.isFinite(maximum) || maximum <= 0 || process.platform !== "darwin") throw new Error("SMD_MAX_GUI_LOAD requires a positive load limit on macOS.");
  while (true) {
    const raw = execFileSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).trim();
    const load = Number(/^\{\s*([\d.]+)/.exec(raw)?.[1]);
    if (!Number.isFinite(load)) throw new Error(`Cannot read the host load: ${raw}`);
    console.log(`GUI admission: load ${raw}, limit < ${maximum}${load < maximum ? "" : "; waiting 60 seconds"}`);
    if (load < maximum) return;
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
}

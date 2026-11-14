import type { UserSettings } from "./config-schema.js";

const letterRegions = new Set(["US", "CA", "MX", "BZ", "CR", "SV", "GT", "HN", "NI", "PA", "CO", "VE", "CL", "PH", "PR", "VI", "GU", "AS", "MP"]);
export function paperSize(setting: UserSettings["paperSize"], locale: string): "A4" | "Letter" {
  if (setting !== "auto") return setting === "a4" ? "A4" : "Letter";
  try {
    const region = new Intl.Locale(locale.replaceAll("_", "-")).maximize().region;
    return region && letterRegions.has(region) ? "Letter" : "A4";
  } catch { return "A4"; }
}
export function printableHeight(size: "A4" | "Letter"): string { return size === "Letter" ? "9.8in" : "10.49in"; }

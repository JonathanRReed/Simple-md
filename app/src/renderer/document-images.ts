import type { ThemeSetting } from "../shared/types.js";

// Keep the authored query for exports and semantic comparison. Only the color-scheme
// clause changes; width, resolution and other media conditions still use the browser.
export function applyImageTheme(root: ParentNode, theme: ThemeSetting): void {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  for (const source of root.querySelectorAll("picture > source[media]")) {
    const media = source.getAttribute("data-simplemd-media") ?? source.getAttribute("media")!;
    if (!/\(\s*prefers-color-scheme\s*:/i.test(media)) continue;
    source.setAttribute("data-simplemd-media", media);
    source.setAttribute("media", media.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi,
      (_clause, scheme: string) => (scheme.toLowerCase() === "dark") === dark ? "(min-width: 0px)" : "(max-width: -1px)"));
  }
}

export function currentImageTheme(): ThemeSetting {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

import { documentThemes } from "../shared/themes.js";
import type { Settings } from "../shared/types.js";
const fontStack = (family: string, fallback: string) => family === "New York" ? `"New York", ui-serif, ${fallback}` : ["system-ui", "ui-serif", "serif", "sans-serif", "ui-monospace"].includes(family) ? `${family}, ${fallback}` : `${JSON.stringify(family)}, ${fallback}`;
const readingFallback = '"Iowan Old Style", "Sitka Text", Constantia, "Noto Serif", "Liberation Serif", Georgia, serif';
export function applyDocumentStyle(settings: Settings): void {
  const root = document.documentElement;
  root.dataset.readingStyle = settings.readingStyle;
  root.style.setProperty("--system-accent", settings.systemAccent ?? "Highlight");
  root.style.setProperty("--reading-font", fontStack(settings.readingFontFamily, readingFallback));
  root.style.setProperty("--writing-font", fontStack(settings.writingFontFamily, "system-ui, sans-serif"));
  root.style.setProperty("--code-font", fontStack(settings.codeFontFamily, '"SF Mono", "Cascadia Mono", Menlo, Consolas, monospace'));
  for (const [token, value] of Object.entries({
    "reading-size": `${settings.readingFontSize}px`, "reading-line-height": settings.readingLineHeight,
    "reading-width": `${settings.contentWidth}ch`, "writing-size": `${settings.writingFontSize}px`,
    "writing-line-height": settings.writingLineHeight, "writing-width": `${settings.writingContentWidth}ch`,
    "code-size": `${settings.codeFontSize}px`, "code-line-height": settings.codeLineHeight, "code-width": `${settings.codeContentWidth}ch`,
  })) root.style.setProperty(`--${token}`, String(value));
  for (const appearance of ["light", "dark"] as const) {
    const theme = documentThemes.find(theme => theme.id === (appearance === "light" ? settings.themeLight : settings.themeDark))!;
    for (const [token, value] of Object.entries(theme)) {
      if (typeof value !== "string" || ["id", "label", "appearance"].includes(token)) continue;
      const name = token.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
      root.style.setProperty(`--${appearance}-${name}`, value);
    }
    for (const [token, value] of Object.entries(theme.syntax)) root.style.setProperty(`--${appearance}-tok-${token}`, value);
  }
}

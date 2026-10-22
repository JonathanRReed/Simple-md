import fs from "node:fs/promises";
import type { BrowserWindow } from "electron";

type Step = { eval: string } | { assert: string } | { wait: number } | { shot: string } | { pdf: string } | { html: string } | { input: Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0] } | { quit: true } | { menuQuit: true };

export async function runDriver(
  win: { webContents: Pick<BrowserWindow["webContents"], "executeJavaScript" | "capturePage" | "sendInputEvent"> },
  file: string,
  toPdf: (target: string) => Promise<void>,
  toHtml?: (target: string) => Promise<void>,
  requestQuit?: () => void,
): Promise<"complete" | "menu-quit"> {
  const steps: Step[] = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Array.isArray(steps)) throw new TypeError("Driver steps must be an array.");
  for (const step of steps) {
    if ("quit" in step) return "complete";
    if ("menuQuit" in step) {
      if (!requestQuit) throw new Error("Menu quit is unavailable.");
      requestQuit();
      return "menu-quit";
    }
    if ("wait" in step) {
      if (!Number.isFinite(step.wait) || step.wait < 0 || step.wait > 60_000) throw new RangeError("Invalid driver wait.");
      await new Promise((resolve) => setTimeout(resolve, step.wait));
    } else if ("pdf" in step) {
      await toPdf(step.pdf);
    } else if ("html" in step) {
      if (!toHtml) throw new Error("HTML export is unavailable.");
      await toHtml(step.html);
    } else if ("eval" in step) {
      await win.webContents.executeJavaScript(step.eval, true);
    } else if ("assert" in step) {
      if (!(await win.webContents.executeJavaScript(step.assert, true))) throw new Error(`Driver assertion failed: ${step.assert}`);
    } else if ("input" in step) {
      win.webContents.sendInputEvent(step.input);
    } else if ("shot" in step) {
      const image = await win.webContents.capturePage();
      await fs.writeFile(step.shot, image.toPNG());
    } else {
      throw new TypeError("Unknown driver step.");
    }
  }
  return "complete";
}

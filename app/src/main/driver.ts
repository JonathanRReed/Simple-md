import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import type { BrowserWindow } from "electron";

export type DriverStep = { paste: string } | { visibility: boolean } | { barrier: string } | { record: { name: string; eval: string } } | { memory: string } | { debug: { method: string; params: Record<string, unknown> } } | { eval: string } | { assert: string } | { wait: number } | { shot: string } | { pdf: string } | { html: string } | { input: Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0] } | { quit: true } | { menuQuit: true };

export async function runDriver(
  win: { isVisible?: () => boolean; webContents: Pick<BrowserWindow["webContents"], "executeJavaScript" | "capturePage" | "sendInputEvent"> & Partial<Pick<BrowserWindow["webContents"], "debugger" | "paste">> },
  file: string,
  toPdf: (target: string) => Promise<void>,
  toHtml?: (target: string) => Promise<void>,
  requestQuit?: () => void,
): Promise<"complete" | "menu-quit"> {
  const steps: DriverStep[] = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Array.isArray(steps)) throw new TypeError("Driver steps must be an array.");
  const needsBarrier = steps.some((step) => "barrier" in step);
  const lines = needsBarrier ? createInterface({ input: process.stdin }) : undefined;
  const acknowledgements = lines?.[Symbol.asyncIterator]();
  try {
    for (const step of steps) {
      if ("quit" in step) return "complete";
      if ("menuQuit" in step) {
        if (!requestQuit) throw new Error("Menu quit is unavailable.");
        requestQuit();
        return "menu-quit";
      }
      if ("paste" in step) {
        if (!win.webContents.paste) throw new Error("Paste is unavailable.");
        const { clipboard, ClipboardItem } = await import("electron");
        const previous = await Promise.all((await clipboard.read()).map(async (item) => new ClipboardItem(Object.fromEntries(
          await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
        ))));
        try {
          await clipboard.writeText(step.paste);
          win.webContents.paste();
          await new Promise((resolve) => setTimeout(resolve, 100));
        } finally { if (previous.length) await clipboard.write(previous); else clipboard.clear(); }
      } else if ("visibility" in step) {
        const deadline = performance.now() + 2000;
        while (win.isVisible?.() !== step.visibility) {
          if (performance.now() > deadline) throw new Error(`Driver visibility did not become ${step.visibility}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } else if ("barrier" in step) {
        console.log(`smd-perf ${JSON.stringify({ kind: "barrier", name: step.barrier })}`);
        const ack = await acknowledgements?.next();
        if (!ack || ack.done || ack.value !== step.barrier) throw new Error("Performance parent disconnected or sent a wrong acknowledgement.");
      } else if ("record" in step) {
        const value: unknown = await win.webContents.executeJavaScript(step.record.eval, true);
        console.log(`smd-perf ${JSON.stringify({ kind: "record", name: step.record.name, value })}`);
      } else if ("memory" in step) {
        const { app, screen, powerMonitor } = await import("electron");
        const processes = app.getAppMetrics().map(({ pid, type, name, memory }) => ({ pid, type, name, memory }));
        console.log(`smd-perf ${JSON.stringify({ kind: "memory", name: step.memory, processes, versions: process.versions, displays: screen.getAllDisplays(), thermalState: powerMonitor.getCurrentThermalState(), onBatteryPower: powerMonitor.isOnBatteryPower() })}`);
      } else if ("debug" in step) {
        if (!win.webContents.debugger) throw new Error("Debugger is unavailable.");
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
        await win.webContents.debugger.sendCommand(step.debug.method, step.debug.params);
      } else if ("wait" in step) {
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
  } finally { lines?.close(); }
}

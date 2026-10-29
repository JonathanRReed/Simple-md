import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import type { BrowserWindow } from "electron";

export type DriverStep = { selectWindow: number | string } | { windowCount: number } | { dialog: { response: 0 | 1 | 2; savePath?: string } } | { save: true } | { page: string } | { throttling: boolean } | { diagnostics: string } | { paste: string } | { visibility: boolean } | { barrier: string } | { record: { name: string; eval: string } } | { memory: string } | { debug: { method: string; params: Record<string, unknown> } } | { eval: string } | { assert: string } | { wait: number } | { shot: string } | { pdf: string } | { html: string } | { input: Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0] } | { quit: true } | { menuQuit: true };

export async function runDriver(
  win: { isVisible?: () => boolean; getBounds?: BrowserWindow["getBounds"]; webContents: Pick<BrowserWindow["webContents"], "executeJavaScript" | "capturePage" | "sendInputEvent"> & Partial<Pick<BrowserWindow["webContents"], "debugger" | "paste" | "setBackgroundThrottling" | "getBackgroundThrottling" | "loadFile" | "send">> },
  file: string,
  toPdf: (target: string) => Promise<void>,
  toHtml?: (target: string) => Promise<void>,
  requestQuit?: () => void,
  save?: () => Promise<void>,
): Promise<"complete" | "menu-quit"> {
  const steps: DriverStep[] = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Array.isArray(steps)) throw new TypeError("Driver steps must be an array.");
  const needsBarrier = steps.some((step) => "barrier" in step);
  const lines = needsBarrier ? createInterface({ input: process.stdin }) : undefined;
  const acknowledgements = lines?.[Symbol.asyncIterator]();
  let restoreSend: (() => void) | undefined;
  let removeDiagnostics: (() => void) | undefined;
  const flushStarted = new Map<number, number>();
  let restoreDialogs: (() => void) | undefined;
  let pendingDialog: { response: 0 | 1 | 2; savePath?: string } | undefined;
  try {
    for (const step of steps) {
      if ("selectWindow" in step) {
        const { BrowserWindow } = await import("electron");
        const all = BrowserWindow.getAllWindows();
        const selection = step.selectWindow;
        const selected = typeof selection === "number" ? all[selection] : (await Promise.all(all.map(async window => ({
          window, file: await window.webContents.executeJavaScript("document.documentElement.dataset.documentPath"),
        })))).find(entry => entry.file === selection)?.window;
        if (!selected) throw new Error("Driver window is missing.");
        win = selected;
        continue;
      }
      if ("windowCount" in step) {
        const { BrowserWindow } = await import("electron");
        if (BrowserWindow.getAllWindows().length !== step.windowCount) throw new Error("Unexpected document window count.");
        continue;
      }
      if ("dialog" in step) {
        const { dialog } = await import("electron");
        const messageBox = dialog.showMessageBox, saveDialog = dialog.showSaveDialog;
        restoreDialogs = () => { dialog.showMessageBox = messageBox; dialog.showSaveDialog = saveDialog; };
        if (pendingDialog) throw new Error("Previous dialog choice was not used.");
        pendingDialog = step.dialog;
        dialog.showMessageBox = async (...args: [Electron.MessageBoxOptions] | [Electron.BaseWindow, Electron.MessageBoxOptions]) => {
          const options = args.at(-1);
          if (!options || typeof options !== "object" || !("message" in options) || !String(options.message).startsWith("Save changes to")) throw new Error("Unexpected driver dialog.");
          if (!pendingDialog) throw new Error("Missing driver dialog choice.");
          const choice = pendingDialog; pendingDialog = undefined;
          dialog.showMessageBox = messageBox;
          if (choice.savePath) dialog.showSaveDialog = async () => {
            dialog.showSaveDialog = saveDialog;
            return { canceled: false, filePath: choice.savePath! };
          };
          return { response: choice.response, checkboxChecked: false };
        };
        continue;
      }
      if ("quit" in step) return "complete";
      if ("menuQuit" in step) {
        if (!requestQuit) throw new Error("Menu quit is unavailable.");
        requestQuit();
        return "menu-quit";
      }
      if ("save" in step) {
        if (!save) throw new Error("Save is unavailable.");
        await save();
      } else if ("page" in step) {
        if (!win.webContents.loadFile) throw new Error("Driver page navigation unavailable");
        await win.webContents.loadFile(step.page);
      } else if ("throttling" in step) {
        if (!win.webContents.setBackgroundThrottling) throw new Error("Background throttling control unavailable");
        win.webContents.setBackgroundThrottling(step.throttling);
      } else if ("diagnostics" in step) {
        const { screen, powerMonitor, app, ipcMain } = await import("electron");
        if (!restoreSend && win.webContents.send) {
          const original = win.webContents.send;
          win.webContents.send = (channel, ...args: unknown[]) => {
            if (channel === "smd:flush-request" && typeof args[0] === "number") {
              flushStarted.set(args[0], performance.now());
              console.log(`smd-perf ${JSON.stringify({ kind: "flush-request", id: args[0] })}`);
            }
            original.call(win.webContents, channel, ...args);
          };
          restoreSend = () => { win.webContents.send = original; };
        }
        removeDiagnostics?.();
        const onFlush = (_event: Electron.IpcMainEvent, id: number, result: { documentId?: number; dirty?: boolean; conflict?: boolean; text?: string }) => {
          const started = flushStarted.get(id);
          flushStarted.delete(id);
          console.log(`smd-perf ${JSON.stringify({ kind: "flush-response", id, roundTripMs: started === undefined ? null : performance.now() - started, documentId: result?.documentId, dirty: result?.dirty, conflict: result?.conflict, textLength: result?.text?.length })}`);
        };
        ipcMain.on("smd:flush-response", onFlush);
        removeDiagnostics = () => { ipcMain.removeListener("smd:flush-response", onFlush); };
        console.log(`smd-perf ${JSON.stringify({ kind: "record", name: step.diagnostics, value: {
          backgroundThrottling: win.webContents.getBackgroundThrottling?.(),
          displays: screen.getAllDisplays(), display: win.getBounds ? screen.getDisplayMatching(win.getBounds()) : null,
          versions: process.versions, thermalState: powerMonitor.getCurrentThermalState(),
          switches: Object.fromEntries(["disable-renderer-backgrounding", "disable-backgrounding-occluded-windows", "disable-background-timer-throttling"].map(name => [name, app.commandLine.hasSwitch(name)])),
        } })}`);
      } else if ("paste" in step) {
        if (!win.webContents.paste) throw new Error("Paste is unavailable.");
        const { clipboard, ClipboardItem } = await import("electron");
        const previous = await Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async (item) => new ClipboardItem(Object.fromEntries(
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
    if (pendingDialog) throw new Error("Expected close dialog did not appear.");
    return "complete";
  } finally { restoreDialogs?.(); removeDiagnostics?.(); restoreSend?.(); lines?.close(); }
}

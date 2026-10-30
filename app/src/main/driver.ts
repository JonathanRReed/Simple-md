import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import type { BrowserWindow } from "electron";

type NativeStep = { nativeChrome: true } | { nativeMenu: string[] } | { nativeContext: { selector: string; context: import("../shared/native-context.js").NativeContext; labels: string[]; choose?: string } } | { nativeIdentity: { file: string; edited: boolean } } | { nativeFind: string | null } | { nativeAccent: true };
export type DriverStep = NativeStep | { nativeMenuState: { path: string[]; enabled: boolean; checked?: boolean; tooltip?: boolean } } | { dragExport: { format: "html" | "pdf"; target: string; receipt: string } } | { nativeMenus: "capture" | "unchanged" | "app-only" | "recents" } | { noSavePrompt: true } | { closeWindow: true } | { settings: DriverStep[] } | { selectWindow: number | string } | { windowCount: number } | { dialog: { response: 0 | 1 | 2; savePath?: string } } | { save: true } | { page: string } | { throttling: boolean } | { diagnostics: string } | { paste: string } | { visibility: boolean } | { barrier: string } | { record: { name: string; eval: string } } | { memory: string } | { debug: { method: string; params: Record<string, unknown> } } | { eval: string } | { assert: string } | { wait: number } | { shot: string } | { pdf: string } | { html: string } | { input: Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0] } | { quit: true } | { menuQuit: true } | { savePath: string };

export async function runDriver(
  win: { isVisible?: () => boolean; getBounds?: BrowserWindow["getBounds"]; webContents: Pick<BrowserWindow["webContents"], "executeJavaScript" | "capturePage" | "sendInputEvent"> & Partial<Pick<BrowserWindow["webContents"], "debugger" | "paste" | "setBackgroundThrottling" | "getBackgroundThrottling" | "loadFile" | "send">> },
  file: string,
  toPdf: (target: string) => Promise<void>,
  toHtml?: (target: string) => Promise<void>,
  requestQuit?: () => void,
  save?: () => Promise<void>,
  nestedSteps?: DriverStep[],
): Promise<"complete" | "menu-quit"> {
  const steps: DriverStep[] = nestedSteps ?? JSON.parse(await fs.readFile(file, "utf8"));
  if (!Array.isArray(steps)) throw new TypeError("Driver steps must be an array.");
  const needsBarrier = steps.some((step) => "barrier" in step);
  const lines = needsBarrier ? createInterface({ input: process.stdin }) : undefined;
  const acknowledgements = lines?.[Symbol.asyncIterator]();
  let restoreFind: (() => Promise<void>) | undefined;
  let restoreSend: (() => void) | undefined;
  let removeDiagnostics: (() => void) | undefined;
  const flushStarted = new Map<number, number>();
  let restoreDialogs: (() => void) | undefined;
  let menuSnapshot: { application: unknown; dock: unknown } | undefined;
  let pendingDialog: { response: 0 | 1 | 2; savePath?: string } | undefined;
  try {
    for (const step of steps) {
      if ("nativeMenuState" in step) {
        const { Menu } = await import("electron");
        let menu = Menu.getApplicationMenu();
        let item: Electron.MenuItem | undefined;
        for (const label of step.nativeMenuState.path) { item = menu?.items.find(i => i.label.replaceAll("&", "") === label); menu = item?.submenu ?? null; }
        if (!item || item.enabled !== step.nativeMenuState.enabled || step.nativeMenuState.checked !== undefined && item.checked !== step.nativeMenuState.checked || step.nativeMenuState.tooltip && !item.toolTip) throw new Error("Native menu state differs.");
        continue;
      }
      if ("dragExport" in step) {
        const { BrowserWindow } = await import("electron");
        const target = BrowserWindow.getAllWindows().find(w => w.webContents === win.webContents);
        if (!target) throw new Error("Drag source window is missing.");
        const startDrag = target.webContents.startDrag;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const dragged = new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Prepared export did not reach startDrag.")), 20000);
            target.webContents.startDrag = options => {
              void (async () => {
                const bytes = await fs.readFile(options.file);
                if (step.dragExport.format === "pdf" ? bytes.subarray(0, 5).toString() !== "%PDF-" : !bytes.toString().startsWith("<!doctype html>")) throw new Error("Drag export is incomplete or has the wrong format.");
                if (options.icon && typeof options.icon !== "string" && options.icon.isEmpty()) throw new Error("Drag icon is empty.");
                await fs.copyFile(options.file, step.dragExport.target);
                await fs.writeFile(step.dragExport.receipt, JSON.stringify({ file: options.file, bytes: bytes.length }));
              })().then(resolve, reject);
            };
          });
          await target.webContents.executeJavaScript(`(async () => {
            const format = document.querySelector('[data-active="true"] [data-element="export-format"]');
            const button = document.querySelector('[data-active="true"] [data-element="drag-export"]');
            format.value = ${JSON.stringify(step.dragExport.format)}; format.dispatchEvent(new Event('change'));
            button.dispatchEvent(new PointerEvent("pointerenter"));
            const deadline = performance.now() + 15000;
            while (!button.draggable) { if (performance.now() > deadline) throw new Error('Export was not prepared.'); await new Promise(r => setTimeout(r, 25)); }
            button.dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true}));
          })()`);
          await dragged;
        } finally { clearTimeout(timer); target.webContents.startDrag = startDrag; }
        continue;
      }
      if ("nativeChrome" in step || "nativeMenu" in step || "nativeContext" in step || "nativeIdentity" in step || "nativeFind" in step || "nativeAccent" in step) {
        const { BrowserWindow, Menu, clipboard, ClipboardItem, systemPreferences } = await import("electron");
        const target = BrowserWindow.getAllWindows().find(w => w.webContents === win.webContents);
        if (!target) throw new Error("Native driver window is missing.");
        if ("nativeMenu" in step) {
          let menu = Menu.getApplicationMenu();
          let item: Electron.MenuItem | undefined;
          for (const label of step.nativeMenu) {
            item = menu?.items.find(i => i.label.replaceAll("&", "") === label);
            if (!item) throw new Error(`Missing native menu item: ${label}`);
            menu = item.submenu ?? null;
          }
          if (!item?.enabled) throw new Error("Native menu item is disabled.");
          item.click({}, target, target.webContents);
        } else if ("nativeChrome" in step && process.platform === "darwin") {
          const position = target.getWindowButtonPosition();
          if (position?.x !== 12 || position.y !== 10) throw new Error("Traffic lights are not aligned with the tab row.");
        } else if ("nativeIdentity" in step && process.platform === "darwin") {
          if (target.getRepresentedFilename() !== step.nativeIdentity.file || target.isDocumentEdited() !== step.nativeIdentity.edited) throw new Error("Native document identity differs.");
        } else if ("nativeFind" in step && process.platform === "darwin") {
          const { readFindText } = await import("./find-pasteboard.js");
          if (!restoreFind) {
            const previous = await readFindText();
            restoreFind = () => clipboard.write([new ClipboardItem({ "electron application/findtext": previous })]);
          }
          if (step.nativeFind !== null && await readFindText() !== step.nativeFind) throw new Error("Native find pasteboard differs.");
        } else if ("nativeAccent" in step && process.platform !== "linux") {
          if (process.platform === "darwin") systemPreferences.postNotification("AppleColorPreferencesChangedNotification", {}, true);
          else systemPreferences.emit("accent-color-changed", {}, systemPreferences.getAccentColor());
        } else if ("nativeContext" in step) {
          const c = step.nativeContext;
          const popup = Menu.prototype.popup;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const shown = new Promise<void>((resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Native context menu did not open.")), 10000);
              Menu.prototype.popup = function(options) {
                try {
                  for (const label of c.labels) if (!this.items.some(item => item.label === label)) throw new Error(`Missing context action: ${label}`);
                  if (c.choose) {
                    const item = this.items.find(item => item.label === c.choose);
                    if (!item) throw new Error("Missing selected context action.");
                    item.click({}, target, target.webContents);
                  }
                  resolve();
                } catch (error) { reject(error); }
                finally { options?.callback?.(); }
              };
            });
            await target.webContents.executeJavaScript(`(() => {
              const el = document.querySelector(${JSON.stringify(c.selector)});
              if (!el) throw new Error('Missing context target');
              const r = el.getBoundingClientRect();
              el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 4, clientY: r.y + r.height / 2 }));
            })()`);
            target.webContents.emit("context-menu", {}, { selectionText: c.context.selectionPresent ? "selected" : "", isEditable: c.context.editable,
              linkURL: c.context.linkURL, srcURL: c.context.imageURL, misspelledWord: c.context.misspelledWord, dictionarySuggestions: c.context.suggestions });
            await shown;
          } finally { clearTimeout(timer); Menu.prototype.popup = popup; }
        }
        continue;
      }
      if ("nativeMenus" in step) {
        const { Menu, app } = await import("electron");
        const snapshot = () => ({ application: Menu.getApplicationMenu(), dock: app.dock?.getMenu() });
        let next = snapshot();
        if (step.nativeMenus === "app-only" && menuSnapshot) {
          const deadline = performance.now() + 2000;
          while (next.application === menuSnapshot.application && performance.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
            next = snapshot();
          }
        }
        if (step.nativeMenus !== "capture") {
          if (!menuSnapshot) throw new Error("Capture native menus before comparing them.");
          const appChanged = next.application !== menuSnapshot.application;
          const dockChanged = next.dock !== menuSnapshot.dock;
          if (appChanged !== (step.nativeMenus !== "unchanged") || process.platform === "darwin" && dockChanged !== (step.nativeMenus === "recents")) throw new Error(`Unexpected native menu rebuild: app=${appChanged}, dock=${dockChanged}`);
        }
        menuSnapshot = next;
        continue;
      }
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
      if ("closeWindow" in step) {
        const { BrowserWindow } = await import("electron");
        const target = BrowserWindow.getAllWindows().find(w => w.webContents === win.webContents);
        if (!target) throw new Error("Driver close window is missing.");
        target.close();
        continue;
      }
      if ("windowCount" in step) {
        const { BrowserWindow } = await import("electron");
        const deadline = performance.now() + 5000;
        while (BrowserWindow.getAllWindows().length !== step.windowCount && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        const actual = BrowserWindow.getAllWindows().length;
        if (actual !== step.windowCount) throw new Error(`Unexpected document window count: ${actual}, expected ${step.windowCount}.`);
        continue;
      }
      if ("noSavePrompt" in step) {
        const { dialog } = await import("electron");
        const original = dialog.showMessageBox;
        restoreDialogs = () => { dialog.showMessageBox = original; };
        dialog.showMessageBox = async () => { throw new Error("Unexpected Save changes prompt."); };
        continue;
      }
      if ("savePath" in step) {
        const { dialog } = await import("electron");
        const original = dialog.showSaveDialog;
        restoreDialogs = () => { dialog.showSaveDialog = original; };
        dialog.showSaveDialog = async () => { dialog.showSaveDialog = original; return { canceled: false, filePath: step.savePath }; };
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
      if ("settings" in step) {
        const { BrowserWindow } = await import("electron");
        let target: BrowserWindow | undefined;
        const deadline = performance.now() + 20000;
        while (!target) {
          target = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith("/settings.html"));
          if (performance.now() > deadline) throw new Error("Settings window did not open.");
          if (!target) await new Promise(resolve => setTimeout(resolve, 20));
        }
        while (target.webContents.isLoadingMainFrame()) await new Promise(resolve => setTimeout(resolve, 20));
        await runDriver(target, file, toPdf, toHtml, requestQuit, save, step.settings);
      } else if ("save" in step) {
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
  } finally { restoreDialogs?.(); removeDiagnostics?.(); restoreSend?.(); await restoreFind?.(); lines?.close(); }
}

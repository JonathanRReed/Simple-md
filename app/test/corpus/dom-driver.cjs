const { app, BrowserWindow, session } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
// Offscreen software rendering supplies frames without a visible native compositor.
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  // Only an empty page and bundled application code run here. No reference assets load.
  session.defaultSession.webRequest.onBeforeRequest((request, done) => {
    done({ cancel: request.url !== "about:blank" });
  });
  const options = JSON.parse(process.env.SMD_DOM_OPTIONS || "{}");
  const window = new BrowserWindow({ show: false, focusable: false, ...(options.screenshot ? { width: options.screenshot.width, height: options.screenshot.height } : {}), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  window.webContents.on("console-message", (event) => console.error(event.message, event.lineNumber, event.sourceId));
  // DOM-PROBE: diagnostics only; do not request extra frames or force paints.
  const entrypoint = process.env.SMD_DOM_ENTRYPOINT;
  const started = Date.now();
  let paints = 0, lastPaint = 0, maxPaintGap = 0;
  window.webContents.on("paint", () => { const now = Date.now(); if (lastPaint) maxPaintGap = Math.max(maxPaintGap, now - lastPaint); lastPaint = now; paints++; });
  const mainProbe = phase => console.error("DOM-MAIN-PROBE", JSON.stringify({ phase, entrypoint, ms: Date.now() - started, paints, lastPaintAge: lastPaint ? Date.now() - lastPaint : null, maxPaintGap, visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), backgroundThrottling: window.webContents.getBackgroundThrottling(), painting: window.webContents.isPainting(), frameRate: window.webContents.getFrameRate() }));
  mainProbe("created");
  await window.loadURL("about:blank");
  await window.webContents.executeJavaScript(`(() => {
    const started = performance.now(), pending = new Map(), events = [];
    let frames = 0, callbacks = 0, lastFrame = 0, maxGap = 0, maxDelay = 0, resizes = 0;
    const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = cb => {
      const requested = performance.now();
      const id = frame(time => {
        pending.delete(id); callbacks++; maxDelay = Math.max(maxDelay, performance.now() - requested);
        if (time !== lastFrame) { if (lastFrame) maxGap = Math.max(maxGap, time - lastFrame); frames++; lastFrame = time; }
        cb(time);
      });
      pending.set(id, requested); return id;
    };
    window.cancelAnimationFrame = id => { pending.delete(id); cancel(id); };
    const observer = window.ResizeObserver;
    window.ResizeObserver = class extends observer {
      constructor(cb) { super((entries, ro) => { resizes++; events.push({ kind: "resize", ms: performance.now() - started, targets: entries.map(e => ({ target: e.target.className, height: e.contentRect.height })) }); if (events.length > 30) events.shift(); cb(entries, ro); }); }
    };
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", { ...descriptor, set(value) {
      descriptor.set.call(this, value);
      events.push({ kind: "scroll-write", ms: performance.now() - started, target: this.className, requested: value, actual: this.scrollTop, caller: new Error().stack });
      if (events.length > 30) events.shift();
    } });
    globalThis.domProbe = phase => {
      const now = performance.now();
      console.error("DOM-PAGE-PROBE", JSON.stringify({ phase, entrypoint: ${JSON.stringify(entrypoint)}, ms: now - started, frames, callbacks, lastFrame, maxGap, maxDelay, pending: [...pending.values()].map(time => now - time), resizes, visibility: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(), events: phase === "heartbeat" ? [] : events, scrollers: phase === "heartbeat" ? [] : [...document.querySelectorAll('.scroller,.cm-scroller')].map(el => ({ target: el.className, connected: el.isConnected, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight })) }));
    };
    setInterval(() => domProbe("heartbeat"), 2000);
    domProbe("start");
  })()`);
  if (options.media?.length) {
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: options.media });
  }
  const [input, bundle, output] = process.argv.slice(-3);
  const loadError = await window.webContents.executeJavaScript(`try { ${readFileSync(bundle, "utf8")}
 null; } catch (error) { String(error.stack); }`);
  if (loadError) throw new Error(loadError);
  const batch = `(async () => { try { return await CorpusBrowser.runBatch(${readFileSync(input, "utf8")}); } catch (error) { globalThis.domProbe("failure"); return { error: String(error.stack) }; } })()`;
  const results = await window.webContents.executeJavaScript(batch);
  await window.webContents.executeJavaScript('globalThis.domProbe("finish")');
  mainProbe("finish");
  if (results.error) throw new Error(results.error);
  async function capture(file) {
    const image = await window.webContents.capturePage();
    if (image.isEmpty()) throw new Error("DOM screenshot is empty");
    writeFileSync(file, image.toPNG());
  }
  if (options.frames) {
    mkdirSync(options.frames.directory, { recursive: true });
    for (const time of options.frames.times) {
      await window.webContents.executeJavaScript(`(async () => {
        for (const animation of document.getAnimations()) {
          if (${time} >= Number(animation.effect.getTiming().duration)) animation.finish();
          else { animation.pause(); animation.currentTime = ${time}; }
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      await capture(path.join(options.frames.directory, `${time}ms.png`));
    }
    await window.webContents.executeJavaScript("globalThis.CorpusBrowser.afterFrames?.()");
  }
  if (options.screenshot) await capture(options.screenshot.path);
  writeFileSync(output, JSON.stringify(results));
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

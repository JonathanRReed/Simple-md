const { app, BrowserWindow, session } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

app.whenReady().then(async () => {
  // Only an empty page and bundled application code run here. No reference assets load.
  session.defaultSession.webRequest.onBeforeRequest((request, done) => {
    done({ cancel: request.url !== "about:blank" });
  });
  const options = JSON.parse(process.env.SMD_DOM_OPTIONS || "{}");
  const window = new BrowserWindow({ show: false, ...(options.screenshot ? { width: options.screenshot.width, height: options.screenshot.height } : {}), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message, event.lineNumber, event.sourceId));
  await window.loadURL("about:blank");
  if (options.media?.length) {
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: options.media });
  }
  const [input, bundle, output] = process.argv.slice(-3);
  const loadError = await window.webContents.executeJavaScript(`try { ${readFileSync(bundle, "utf8")}
 null; } catch (error) { String(error.stack); }`);
  if (loadError) throw new Error(loadError);
  const batch = `(async () => { try { return await CorpusBrowser.runBatch(${readFileSync(input, "utf8")}); } catch (error) { return { error: String(error.stack) }; } })()`;
  const results = await window.webContents.executeJavaScript(batch);
  if (results.error) throw new Error(results.error);
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
      writeFileSync(path.join(options.frames.directory, `${time}ms.png`), (await window.webContents.capturePage()).toPNG());
    }
    await window.webContents.executeJavaScript("globalThis.CorpusBrowser.afterFrames?.()");
  }
  if (options.screenshot) writeFileSync(options.screenshot.path, (await window.webContents.capturePage()).toPNG());
  writeFileSync(output, JSON.stringify(results));
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

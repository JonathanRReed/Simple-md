const { app, BrowserWindow, session } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");

app.whenReady().then(async () => {
  // Only an empty page and bundled application code run here. No reference assets load.
  session.defaultSession.webRequest.onBeforeRequest((request, done) => {
    done({ cancel: request.url !== "about:blank" });
  });
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on("console-message", (event) => console.error(event.message, event.lineNumber, event.sourceId));
  await window.loadURL("about:blank");
  const [input, bundle, output] = process.argv.slice(-3);
  const loadError = await window.webContents.executeJavaScript(`try { ${readFileSync(bundle, "utf8")}
 null; } catch (error) { String(error.stack); }`);
  if (loadError) throw new Error(loadError);
  const batch = `(async () => { try { return await CorpusBrowser.runBatch(${readFileSync(input, "utf8")}); } catch (error) { return { error: String(error.stack) }; } })()`;
  const results = await window.webContents.executeJavaScript(batch);
  if (results.error) throw new Error(results.error);
  writeFileSync(output, JSON.stringify(results));
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

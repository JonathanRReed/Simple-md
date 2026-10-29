import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../", import.meta.url));
export async function windowsRenderBundle() {
  const result = await Bun.build({
    entrypoints: [path.join(appDir, "src/shared/render-browser.ts")],
    target: "browser", format: "iife", minify: true, splitting: false,
    conditions: ["worker"], define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "Windows static renderer build failed");
  if (result.outputs.length !== 1) throw new Error("Windows renderer must be a single file");
  return result.outputs[0].text();
}

if (import.meta.main) {
  await Bun.write(path.join(appDir, "native/windows-preview/render-core.js"), await windowsRenderBundle());
}

import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export interface DefaultAppResult { type: string; extensions: string[]; handler: string | null; success: boolean; error: string | null }
export function parseDefaultAppResults(raw: string): DefaultAppResult[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("No Markdown types were returned by macOS.");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("type" in entry) || typeof entry.type !== "string" || !entry.type ||
        !("extensions" in entry) || !Array.isArray(entry.extensions) || !entry.extensions.length || !entry.extensions.every((ext: unknown) => typeof ext === "string" && ["md", "markdown", "mdown", "mkd", "mdx"].includes(ext)) ||
        !("handler" in entry) || entry.handler !== null && typeof entry.handler !== "string" || !("success" in entry) || typeof entry.success !== "boolean" ||
        !("error" in entry) || entry.error !== null && typeof entry.error !== "string") throw new Error("Invalid default-app result.");
    return { type: entry.type, extensions: entry.extensions, handler: entry.handler, success: entry.success, error: entry.error };
  });
}
export function defaultAppMessage(results: DefaultAppResult[]): string {
  const failed = results.filter(result => !result.success);
  const set = [...new Set(results.filter(result => result.success).flatMap(result => result.extensions))];
  return [set.length ? `SimpleMD is the default for ${set.map(ext => `.${ext}`).join(", ")}.` : "",
    failed.length ? `macOS did not change: ${failed.map(result => result.type).join(", ")}.` : ""].filter(Boolean).join(" ");
}
export async function setDefaultMarkdownApp(options: { platform: NodeJS.Platform; packaged: boolean; resources: string; executable: string; openExternal(url: string): Promise<void> }, runHelper: (file: string, args: string[], options: { timeout: number; maxBuffer: number; killSignal: "SIGKILL" }) => Promise<{ stdout: string }> = run): Promise<string> {
  if (options.platform === "win32") {
    await options.openExternal("ms-settings:defaultapps");
    return "Choose SimpleMD for .md, .markdown and .mdx in Default apps.";
  }
  if (options.platform === "darwin") {
    if (!options.packaged) throw new Error("Install SimpleMD in Applications before making it the default app.");
    const helper = path.join(options.resources, "native/simplemd-default-app");
    const application = path.resolve(options.executable, "../../..");
    const { stdout } = await runHelper(helper, ["--set", application], { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    return defaultAppMessage(parseDefaultAppResults(stdout));
  }
  const folders = [process.env.XDG_DATA_HOME || path.join(process.env.HOME ?? "", ".local/share"), ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")];
  const desktop = folders.map(folder => path.join(folder, "applications/simplemd.desktop")).find(file => fs.existsSync(file));
  if (!desktop) return "Choose SimpleMD for text/markdown in your system’s Default Applications settings.";
  try { await run("xdg-mime", ["default", path.basename(desktop), "text/markdown"], { timeout: 5000 }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "Choose SimpleMD for text/markdown in your system’s Default Applications settings.";
    throw error;
  }
  const { stdout } = await run("xdg-mime", ["query", "default", "text/markdown"], { timeout: 5000 });
  if (stdout.trim() !== path.basename(desktop)) throw new Error("The system did not change the default Markdown app.");
  return "SimpleMD is the default Markdown app.";
}

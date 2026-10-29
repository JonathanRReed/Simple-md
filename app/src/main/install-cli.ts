import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, dialog } from "electron";

export function bundledCli(): string {
  const executable = process.platform === "win32" ? "simplemd.exe" : "simplemd";
  return app.isPackaged ? path.join(process.resourcesPath, "native", executable) : path.join(app.getAppPath(), "native", "target", "release", executable);
}
export async function installCli(): Promise<void> {
  try {
    const binary = bundledCli(); await fs.promises.access(binary, fs.constants.X_OK);
    let directory = "/usr/local/bin";
    if (!(await fs.promises.access(directory, fs.constants.W_OK).then(() => true, () => false))) directory = path.join(os.homedir(), ".local", "bin");
    await fs.promises.mkdir(directory, { recursive: true });
    const target = path.join(directory, "simplemd");
    const stat = await fs.promises.lstat(target).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat) {
      if (!stat.isSymbolicLink()) throw new Error(`A file already exists at ${target}.`);
      if (await fs.promises.readlink(target) !== binary) throw new Error(`A different symlink already exists at ${target}. Remove it before installing.`);
    } else await fs.promises.symlink(binary, target);
    await dialog.showMessageBox({ type: "info", message: `Installed ${target}`, detail: directory === "/usr/local/bin" ? "Run simplemd from your terminal." : `Add ${directory} to your PATH to run simplemd.` });
  } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Could not install the command line tool.", detail: error instanceof Error ? error.message : String(error) });
  }
}

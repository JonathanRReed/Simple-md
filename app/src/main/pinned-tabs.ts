import fs from "node:fs/promises";

export async function existingPinnedPaths(paths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const file of paths) {
    if (await fs.stat(file).then(stat => stat.isFile(), () => false)) files.push(file);
  }
  return files;
}

import fs from "node:fs/promises";

/** A draft owns only a missing path. A real file gets the normal file-open path. */
export async function matchesOpenPath(session: { path: string | null; draftPath?: string }, absolute: string, canonical: string): Promise<boolean> {
  const file = session.path ?? session.draftPath;
  if (!file) return false;
  if (!session.path && await fs.lstat(file).then(() => true, () => false)) return false;
  return file === absolute || await fs.realpath(file).catch(() => file) === canonical;
}

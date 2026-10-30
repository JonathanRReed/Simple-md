import type { DocumentLocation, OpenIntent } from "./types.js";

/** Reading is the default. Editor jobs and explicit line targets start in Source. */
export function opensInSource(file: string, wait = false, location?: DocumentLocation): boolean {
  const name = file.split(/[\\/]/).pop() ?? file;
  return wait || location?.kind === "line" || name === "COMMIT_EDITMSG" || name.lastIndexOf(".") <= 0;
}
export function fileOpenIntent(file: string, wait = false, location?: DocumentLocation): OpenIntent {
  return opensInSource(file, wait, location) ? "edit" : "read";
}

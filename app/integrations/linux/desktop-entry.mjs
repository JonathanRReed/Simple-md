import path from "node:path";

// Exec quoting has two layers: quoted arguments, then desktop string escaping.
export function desktopEntry(executable) {
  if (!executable || !path.posix.isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable)) {
    throw new Error("Pass an absolute Linux executable or AppImage path without control characters.");
  }
  const quoted = executable
    .replace(/%/g, "%%")
    .replace(/["`$\\]/g, "\\$&")
    .replace(/\\/g, "\\\\");
  return `[Desktop Entry]\nType=Application\nName=SimpleMD\nComment=View and edit Markdown\nExec="${quoted}" %f\nIcon=text-markdown\nTerminal=false\nCategories=Office;TextEditor;\nMimeType=text/markdown;text/x-markdown;\nStartupWMClass=simplemd\n`;
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun desktop-entry.mjs /absolute/path/to/SimpleMD.AppImage");
  process.stdout.write(desktopEntry(process.argv[2]));
}

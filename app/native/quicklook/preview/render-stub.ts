// M4 integration stub. Replace this entry with the shared static renderer when it lands.
// This function returns a complete script-free HTML document, not an HTML fragment.
export function renderStaticHtml(
  source: string,
  filePath: string,
  options: { appearance: "light" | "dark"; truncated: boolean; invalidUtf8: boolean },
): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
  const title = filePath.split("/").pop() ?? "";
  const note = options.truncated ? "<p>Showing the first 4 MB. Open in SimpleMD to read the whole file.</p>" : "";
  const encoding = options.invalidUtf8 ? "<p>Invalid UTF-8 bytes appear as replacement characters.</p>" : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
<title>${escape(title)}</title><style>
:root{color-scheme:${options.appearance === "dark" ? "dark" : "light"}}
body{font:16px system-ui;padding:24px;color:${options.appearance === "dark" ? "#eee" : "#222"};background:${options.appearance === "dark" ? "#202020" : "#fff"}}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px ui-monospace,Menlo,monospace}p{font-size:14px}
</style></head><body>${note}${encoding}<pre>${escape(source)}</pre></body></html>`;
}

Object.assign(globalThis, { renderStaticHtml });

const escape = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export async function renderFrontmatter(source: string): Promise<string> {
  try {
    const { parseDocument } = await import("yaml");
    const doc = parseDocument(source.split(/^\.\.\.\s*$/m)[0]!, { schema: "core", uniqueKeys: true });
    if (doc.errors.length) throw new Error("Invalid frontmatter");
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    const table = (value: unknown, top: boolean, depth: number): string => {
      if (depth > 20) throw new Error("Frontmatter nesting limit");
      if (record(value)) {
        const entries = Object.entries(value);
        if (top) return `<table><tbody>${entries.map(([key, child]) => `<tr><th>${escape(key)}</th><td>${record(child) || Array.isArray(child) ? `<div class="frontmatter-value">${table(child, false, depth + 1)}</div>` : table(child, false, depth + 1)}</td></tr>`).join("")}</tbody></table>`;
        return `<table><thead><tr>${entries.map(([key]) => `<th>${escape(key)}</th>`).join("")}</tr></thead><tbody><tr>${entries.map(([, child]) => `<td><div>${table(child, false, depth + 1)}</div></td>`).join("")}</tr></tbody></table>`;
      }
      if (Array.isArray(value)) return `<table><tbody><tr>${value.map((child: unknown) => `<td><div>${table(child, false, depth + 1)}</div></td>`).join("")}</tr></tbody></table>`;
      return escape(value);
    };
    const summary = record(value) ? [value.title, value.date, value.tags].flatMap((item) =>
      Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : typeof item === "string" || typeof item === "number" ? [String(item)] : [],
    ).join(" · ") : "";
    return `<details class="frontmatter"><summary>${escape(summary || "Metadata")}</summary><div class="frontmatter-body">${table(value, true, 0)}</div></details>`;
  } catch {
    return `<details class="frontmatter"><summary>Metadata</summary><div class="frontmatter-body"><pre>${escape(source)}</pre></div></details>`;
  }
}

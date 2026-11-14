import { expect, test } from "bun:test";
import fs from "node:fs/promises";

test("dormant saves retain incoming text and resolve old-path changes after Save As", async () => {
  for (const moved of [false, true]) {
    const source = await fs.readFile(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
    const code = source.slice(source.indexOf("  api.onSaved(result => {"), source.indexOf("  api.onDiskChanged("));
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const incoming = { kind: "text", text: "external edit" };
    const tab = { disk: incoming, retained: { disk: undefined, state: {
      unavailableReason: undefined, diskConflict: true, dirty: true, readText: "saved local", savedText: "before", meta: { path: "/tmp/note.md" },
    } } };
    let saved = (_result: object) => {};
    new Function("api", "documents", "panes", "noticeSaveMetadata", "syncChrome", compiled)(
      { onSaved: (callback: typeof saved) => { saved = callback; } }, new Map([[1, tab]]), new Map(), () => {}, () => {});
    saved({ documentId: 1, text: "saved local", path: moved ? "/tmp/other.md" : "/tmp/note.md" });
    expect(tab.retained.state.readText).toBe("saved local");
    expect(tab.retained.state.dirty).toBe(false);
    expect(tab.retained.state.diskConflict).toBe(!moved);
    expect(tab.disk).toEqual(moved ? undefined : incoming);
  }
});

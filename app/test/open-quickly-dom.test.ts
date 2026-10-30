import { expect, test } from "bun:test";
import path from "node:path";
import { runDom } from "./dom-runner";

test("Open Quickly keyboard navigation, highlights, scope, stale replies, opening and focus restoration", async () => {
  expect(await runDom(path.join(import.meta.dir, "open-quickly/browser.ts"), [])).toEqual({
    immediate: 2,
    aria: { role: "combobox", controls: "picker-list", expanded: "true", label: "Open Quickly" },
    down: "picker-opt-1", up: "picker-opt-0", highlights: "RDM", staleIgnored: "guide.mdx",
    scope: "Everywhere", scopes: ["repo", "repo", "repo", "everywhere", "everywhere", "everywhere", "everywhere", "everywhere"],
    opens: [{ file: "/docs/guide.mdx", otherPane: true }, { file: "/docs/README.md", otherPane: false }],
    restored: "restore", hiddenAfterReply: true, remembered: "Everywhere", emptyActive: "", staysOpen: true, closes: 4, unsubscribed: true,
  });
}, 30000);

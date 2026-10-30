import { expect, test } from "bun:test";
import { splitTabLabel, tabLabel } from "../src/shared/tab-labels";
test("duplicate names include enough parent folders to identify the file", () => {
  const a = { name: "README.md", path: "/work/one/docs/README.md" };
  const b = { name: "README.md", path: "/work/two/docs/README.md" };
  expect(tabLabel(a, [a])).toBe("README.md");
  expect(tabLabel(a, [a, b])).toBe("README.md · one/docs");
  expect(tabLabel(b, [a, b])).toBe("README.md · two/docs");
  const c = { name: "README.md", path: "C:\\work\\other\\README.md" };
  expect(tabLabel(c, [a, c])).toBe("README.md · other");
});

test("narrow tabs keep the file ending and ellipsize the start", () => {
  expect(splitTabLabel("miss-13-ceiling.md")).toEqual(["miss-13-cei", "ling.md"]);
  expect(splitTabLabel("README.md")).toEqual(["README.md", ""]);
  expect(splitTabLabel("README.md · docs").join("")).toBe("README.md · docs");
});

test("pinned fragments distinguish shared initials, prefixes, case and duplicate names", async () => {
  const { pinnedTabLabels } = await import("../src/shared/tab-labels");
  const labels = ["PLAN.md", "PLAN_ARCHIVE.md", "README.md", "Readme.md", "document.md", "documentary.md", "README.md · one", "README.md · two"];
  const fragments = pinnedTabLabels(labels);
  expect(new Set(fragments.map(label => label.toLowerCase())).size).toBe(labels.length);
  expect(fragments[0]).toBe("PLAN"); expect(fragments[1]).toBe("PLAN_A");
  expect(fragments.every(label => label.length > 1 && label.length <= 6)).toBe(true);
});

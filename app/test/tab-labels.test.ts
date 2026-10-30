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

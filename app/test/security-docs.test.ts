import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

test("save documentation describes a short-lived helper and non-fatal metadata failures", () => {
  const readme = fs.readFileSync(path.join(import.meta.dir, "../README.md"), "utf8");
  expect(readme).toContain("A metadata-copy failure logs an error and the save proceeds.");
  expect(readme).toContain("one short-lived process per save");
  expect(readme).not.toContain("failure cancels the save");
});

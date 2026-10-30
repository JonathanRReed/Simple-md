import { expect, test } from "bun:test";
import { deriveOutline, outlineIndex, outlineProgress, outlineScale, outlineScroll, outlineViewport, OUTLINE_LIMIT, type OutlineItem } from "../src/renderer/outline-model";
import { configDefaults } from "../src/shared/config-schema";
import { parseConfig, serializeConfig, validateUserPatch } from "../src/shared/config";

const heading = (level: number, index: number): OutlineItem<number> => ({ key: String(index), level, text: `Heading ${index}`, target: index });

test("outline filters levels, preserves duplicate identities and samples the complete document", () => {
  const headings = Array.from({ length: 5000 }, (_, i) => heading(i % 6 + 1, i));
  const items = deriveOutline(headings, []);
  expect(items).toHaveLength(OUTLINE_LIMIT);
  expect(items.every(item => item.level <= 3)).toBe(true);
  expect(items[0]).toEqual(headings[0]);
  expect(items.at(-1)).toEqual(headings[4999]);
  expect(new Set(items.map(item => item.key)).size).toBe(items.length);
  expect(deriveOutline(headings.slice(0, 6), [], 6)).toHaveLength(6);
  expect(deriveOutline([heading(4, 0)], [])).toEqual([]);
});

test("heading-free documents sample block identities, while empty documents have no rail", () => {
  const blocks = Array.from({ length: 1000 }, (_, i) => ({ ...heading(0, i), text: `Section ${i + 1}` }));
  const items = deriveOutline([], blocks);
  expect(items).toHaveLength(24);
  expect(items[0]?.key).toBe("0"); expect(items.at(-1)?.key).toBe("999");
  expect(deriveOutline([], [])).toEqual([]);
});

test("magnification uses only distance and the T3 strip scales", () => {
  expect([0, 1, 2, 3, 4].map(index => outlineScale(index, 2))).toEqual([0.417, 0.667, 1, 0.667, 0.417]);
  expect(outlineScale(0, null)).toBe(0.333); expect(outlineScale(0, 5)).toBe(0.333);
});

test("pointer mapping and viewport geometry clamp endpoints and handle short documents", () => {
  expect(outlineProgress(60, 10, 100)).toBe(0.5);
  expect(outlineProgress(-10, 10, 100)).toBe(0); expect(outlineProgress(200, 10, 100)).toBe(1);
  expect(outlineProgress(10, 10, 0)).toBe(0);
  expect(outlineIndex(0.5, 5)).toBe(2); expect(outlineIndex(0, 0)).toBeNull(); expect(outlineIndex(1, 1)).toBe(0);
  expect(outlineScroll(0.5, 2000, 400)).toBe(800); expect(outlineScroll(1, 200, 400)).toBe(0);
  expect(outlineScroll(2, 2000, 400)).toBe(1600);
  expect(outlineViewport(800, 400, 2000)).toEqual({ start: 0.4, size: 0.2 });
  expect(outlineViewport(0, 400, 0)).toEqual({ start: 0, size: 1 });
});

test("outline config defaults, validates and round trips through generated settings", () => {
  expect(configDefaults).toMatchObject({ outlineRail: true, outlineRailLevels: 3 });
  const patch = { outlineRail: false, outlineRailLevels: 6 };
  expect(parseConfig(serializeConfig("", patch)).settings).toMatchObject(patch);
  expect(validateUserPatch(patch)).toEqual(patch);
  for (const value of [0, 7, 2.5]) expect(parseConfig(`outline-rail-levels = ${value}`).issues).toHaveLength(1);
  expect(parseConfig("outline-rail = false\noutline-rail-levels = 2").settings).toMatchObject({ outlineRail: false, outlineRailLevels: 2 });
});

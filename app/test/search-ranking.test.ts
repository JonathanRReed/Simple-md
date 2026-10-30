import { describe, expect, it } from "bun:test";

import {
  insertRankedSearchResult,
  scoreQueryMatch,
  scoreSubsequenceMatch,
} from "../src/shared/search-ranking";

describe("scoreQueryMatch", () => {
  it("treats boundary matches as stronger than generic contains matches", () => {
    const boundaryScore = scoreQueryMatch({
      value: "gh-fix-ci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });
    const containsScore = scoreQueryMatch({
      value: "highfixci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });

    expect(boundaryScore).not.toBeNull();
    expect(containsScore).not.toBeNull();
    expect(boundaryScore!).toBeLessThan(containsScore!);
  });
});

describe("scoreSubsequenceMatch", () => {
  it("scores tighter subsequences ahead of looser ones", () => {
    const compact = scoreSubsequenceMatch("ghfixci", "gfc");
    const spread = scoreSubsequenceMatch("github-fix-ci", "gfc");

    expect(compact).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(compact!).toBeLessThan(spread!);
  });
});

describe("insertRankedSearchResult", () => {
  it("keeps the best-ranked candidates within the limit", () => {
    const ranked = [
      { item: "b", score: 20, tieBreaker: "b" },
      { item: "d", score: 40, tieBreaker: "d" },
    ];

    insertRankedSearchResult(ranked, { item: "a", score: 10, tieBreaker: "a" }, 2);
    insertRankedSearchResult(ranked, { item: "c", score: 30, tieBreaker: "c" }, 2);

    expect(ranked.map((entry) => entry.item)).toEqual(["a", "b"]);
  });
});

import { normalizeSearchQuery, findMatchIndices } from "../src/shared/search-ranking";
it("normalizes queries and returns substring and subsequence highlight indices", () => {
  expect(normalizeSearchQuery("  ./README ", { trimLeadingPattern: /^[./]+/ })).toBe("readme");
  expect(normalizeSearchQuery("  ")).toBe("");
  expect(findMatchIndices("README.md", "rdm")).toEqual([0, 3, 4]);
  expect(findMatchIndices("read-readme", "readme")).toEqual([5, 6, 7, 8, 9, 10]);
  expect(findMatchIndices("note.md", "missing")).toEqual([]);
  expect(scoreSubsequenceMatch("note", "xyz")).toBeNull();
});
it("caps top-K at zero and sorts equal scores deterministically", () => {
  const ranked: { item: string; score: number; tieBreaker: string }[] = [];
  insertRankedSearchResult(ranked, { item: "x", score: 0, tieBreaker: "x" }, 0);
  expect(ranked).toEqual([]);
  for (const item of ["c", "a", "b"]) insertRankedSearchResult(ranked, { item, score: 1, tieBreaker: item }, 2);
  expect(ranked.map(x => x.item)).toEqual(["a", "b"]);
});

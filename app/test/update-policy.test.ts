import { expect, test } from "bun:test";
import { updateDecision, updateInterval, type UpdateGate } from "../src/shared/update-policy.js";
import { parseConfig, serializeConfig } from "../src/shared/config.js";

const release: UpdateGate = { packaged: true, platform: "darwin", signed: true, appImage: false,
  enabled: true, manual: false, now: updateInterval * 3, lastCheck: 0 };
test("updates skip development and unsigned macOS, including manual requests", () => {
  for (const manual of [false, true]) {
    expect(updateDecision({ ...release, manual, packaged: false })).toBe("development");
    expect(updateDecision({ ...release, manual, signed: false })).toBe("unsigned");
  }
});
test("automatic checks respect preference and persisted daily limit", () => {
  expect(updateDecision(release)).toBe("check");
  expect(updateDecision({ ...release, enabled: false })).toBe("disabled");
  expect(updateDecision({ ...release, lastCheck: release.now - updateInterval + 1 })).toBe("recent");
  expect(updateDecision({ ...release, lastCheck: release.now - updateInterval })).toBe("check");
  expect(updateDecision({ ...release, lastCheck: release.now + 100 })).toBe("recent");
  expect(updateDecision({ ...release, enabled: false, lastCheck: release.now, manual: true })).toBe("check");
});
test("Windows and AppImage use release updates, DEB uses its package manager", () => {
  expect(updateDecision({ ...release, platform: "win32", signed: false })).toBe("check");
  expect(updateDecision({ ...release, platform: "linux", appImage: true })).toBe("check");
  expect(updateDecision({ ...release, platform: "linux", manual: true })).toBe("unsupported");
});
test("auto-update is a schema-driven boolean with round-trip persistence", () => {
  expect(parseConfig("").settings.autoUpdate).toBe(true);
  expect(parseConfig("auto-update = false\n").settings.autoUpdate).toBe(false);
  expect(parseConfig("auto-update = never\n").issues).toHaveLength(1);
  expect(parseConfig(serializeConfig("# keep\n", { autoUpdate: false })).settings.autoUpdate).toBe(false);
});

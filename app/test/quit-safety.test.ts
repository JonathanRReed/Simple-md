import { expect, test } from "bun:test";
import { quitAfterSettle, settleAllWindows, releaseQuitWindows, canOpenWindow } from "../src/main/lifecycle";

interface Host { quitFrozen?: boolean; busy: boolean }
function adapters(settle: (host: Host) => Promise<boolean>) {
  const a: Host = { busy: false }, b: Host = { busy: false };
  const hosts = [a, b];
  const busy = (host: Host, value: boolean) => { host.busy = value; };
  return { a, b, api: {
    settleAllWindows: () => settleAllWindows(hosts, busy, settle),
    releaseQuitWindows: () => releaseQuitWindows(hosts, busy),
  } };
}

test("quit freezes every window before settlement and holds them through cleanup", async () => {
  let calls = 0;
  const { a, b, api } = await adapters(async () => {
    expect(a.busy).toBe(true); expect(b.busy).toBe(true); calls++;
    return true;
  });
  expect(await quitAfterSettle({ settle: api.settleAllWindows, cancel: api.releaseQuitWindows,
    cleanup: async () => { expect(a.busy).toBe(true); expect(b.busy).toBe(true); }, exit() {} })).toBe(true);
  expect(calls).toBe(2); expect(a.busy).toBe(true); expect(b.busy).toBe(true);
});
for (const failure of ["cancel", "settle error", "cleanup error"]) test(`quit releases every window after ${failure}`, async () => {
  const { a, b, api } = await adapters(async () => { expect(a.busy).toBe(true); expect(b.busy).toBe(true); if (failure === "settle error") throw new Error("settle failed"); return failure !== "cancel"; });
  const result = quitAfterSettle({ settle: api.settleAllWindows, cancel: api.releaseQuitWindows,
    cleanup: async () => { throw new Error("cleanup failed"); }, exit() { throw new Error("Unexpected exit"); } });
  if (failure === "cancel") expect(await result).toBe(false);
  else await expect(result).rejects.toThrow("failed");
  expect(a.busy).toBe(false); expect(b.busy).toBe(false);
});

test("New Window cannot create an unfrozen window during quit settlement", () => {
  expect(canOpenWindow([{ quitFrozen: true }, { quitFrozen: false }])).toBe(false);
  expect(canOpenWindow([{ quitFrozen: false }])).toBe(true);
  expect(canOpenWindow([])).toBe(true);
});

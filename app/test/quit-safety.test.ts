import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import { quitAfterSettle } from "../src/main/lifecycle";

async function adapters(settle: (host: Host) => Promise<boolean>) {
  const source = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const extract = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    extract("async function transition<T>", "async function settle(") +
    (source.includes("function releaseQuitWindows()") ? extract("function releaseQuitWindows()", "async function newDocumentWindow()") : "function releaseQuitWindows() {}\n" + extract("async function settleAllWindows()", "async function newDocumentWindow()")));
  const a: Host = { layout: { state: { tabs: [1] } }, busy: false };
  const b: Host = { layout: { state: { tabs: [2] } }, busy: false };
  let current = a;
  const create = new Function("windows", "windowScope", "settle", "registry", "sendTo", "context", "let quitting = false;\n" + code + "\nreturn { settleAllWindows, releaseQuitWindows };");
  const api = create(new Map([[1, a], [2, b]]), { run: async (host: Host, fn: () => Promise<boolean>) => { current = host; return fn(); } },
    () => settle(current), { get: () => ({}) }, (host: Host, _channel: string, busy: boolean) => { host.busy = busy; }, () => current);
  return { a, b, api };
}
interface Host { layout: { state: { tabs: number[] } }; busy: boolean }

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

test("New Window cannot create an unfrozen window during quit settlement", async () => {
  const source = await fs.readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("async function newDocumentWindow()"), source.indexOf("function runCommand("));
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
  let created = 0;
  const open = new Function("windows", "createDocumentWindow", "windowScope", "reveal", "newDoc", compiled + "\nreturn newDocumentWindow;")(
    new Map([[1, { quitFrozen: true }]]), () => { created++; return {}; }, { run: async (_host: unknown, operation: () => Promise<void>) => operation() }, () => {}, async () => {});
  await open(); expect(created).toBe(0);
});

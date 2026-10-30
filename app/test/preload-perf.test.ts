import { expect, test } from "bun:test";
import { Script } from "node:vm";
import path from "node:path";
import type { Bridge } from "../src/renderer/api";
import { makeDocumentId } from "../src/shared/types";

test("startup tracing is configured before the ready reply releases early paint markers", async () => {
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../src/preload.ts")], target: "node", format: "cjs", external: ["electron"] });
  expect(built.success).toBe(true);
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sent: unknown[][] = [];
  let api: Pick<Bridge, "ready" | "perfMarker"> | undefined;
  let reply: ((value: unknown) => void) | undefined;
  const electron = {
    contextBridge: { exposeInMainWorld(_name: string, exposed: NonNullable<typeof api>) { api = exposed; } },
    ipcRenderer: {
      on(channel: string, listener: (...args: unknown[]) => void) { listeners.set(channel, listener); },
      send(...args: unknown[]) { sent.push(args); },
      invoke: () => new Promise(resolve => { reply = resolve; }),
    },
    webUtils: {},
  };
  new Script(await built.outputs[0]!.text()).runInNewContext({ require: () => electron, performance });
  if (!api) throw new Error("Preload did not expose its bridge");
  const ready = api.ready();
  api.perfMarker(makeDocumentId(1), "renderer-receive");
  expect(sent).toHaveLength(0);
  listeners.get("smd:performance-tracing")?.({}, true);
  api.perfMarker(makeDocumentId(1), "first-readable");
  expect(sent).toEqual([["smd:perf-marker", makeDocumentId(1), "first-readable", expect.any(Number)]]);
  listeners.get("smd:performance-tracing")?.({}, false);
  api.perfMarker(makeDocumentId(1), "first-readable");
  expect(sent).toHaveLength(1);
  reply?.({}); await ready;
});

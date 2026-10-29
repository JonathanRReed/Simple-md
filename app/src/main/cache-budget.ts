import { workerData } from "node:worker_threads";
import { CacheBudget } from "../shared/byte-cache.js";

const data: unknown = workerData;
const config: unknown = typeof data === "object" && data !== null && "cacheBudget" in data ? data.cacheBudget : undefined;
const shared = typeof config === "object" && config !== null && "buffer" in config && config.buffer instanceof SharedArrayBuffer &&
  config.buffer.byteLength === 128 && "owner" in config && typeof config.owner === "number" && Number.isInteger(config.owner) && config.owner >= 2 && config.owner < 32 ? { buffer: config.buffer, owner: config.owner } : undefined;
export const cacheBudget = new CacheBudget(16 * 1024 * 1024, shared?.buffer, shared?.owner);

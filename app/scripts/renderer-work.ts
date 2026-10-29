import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDom } from "../test/dom-runner";
import { perfFixtures } from "./perf-fixtures";

const start = os.loadavg();
const result = await runDom(path.join(import.meta.dir, "../test/renderer/work.ts"), perfFixtures()["typing-100k.md"]!);
const receipt = { revision: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(), loadStart: start, loadEnd: os.loadavg(),
  method: "Five interleaved pairs after one warmup pair. Each sample moves the cursor 100 times. Full rebuild and incremental state use the same builder and syntax tree. This measures decoration CPU, not input-to-paint.", result };
const output = path.join(import.meta.dir, "../../.audit/renderer-work.json");
fs.writeFileSync(output, JSON.stringify(receipt, null, 2));
console.log(output);

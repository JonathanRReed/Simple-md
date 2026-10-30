import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

test("Windows acceptance deadline covers connection and first response, then stops for wait", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dir, "../native/src/cli/windows.rs"), "utf8");
  const connect = source.slice(source.indexOf("pub fn connect("), source.indexOf("pub fn interrupt_handler("));
  expect(connect.includes("connect_pipe(&name, Duration::from_secs(30))")).toBe(true);
  expect(connect.indexOf("AcceptanceDeadline::new")).toBeLessThan(connect.indexOf("CreateFileW("));
  expect(connect.includes("CancelIoEx")).toBe(true);
  expect(connect.includes("CancelSynchronousIo")).toBe(true);
  expect(connect.includes("stream.deadline.cancel()")).toBe(true);
});

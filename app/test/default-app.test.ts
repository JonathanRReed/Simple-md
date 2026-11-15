import { expect, test } from "bun:test";
import { parseDefaultAppResults, defaultAppMessage, setDefaultMarkdownApp } from "../src/main/default-app";
test("default-app results distinguish success, system refusal, unregistered extensions and malformed helper output", () => {
  const results = [{ type: "net.daringfireball.markdown", extensions: ["md", "markdown", "mdown", "mkd"], handler: "/Applications/SimpleMD.app", success: true, error: null }, { type: "mdx.type", extensions: ["mdx"], handler: null, success: false, error: "Declined" }];
  expect(parseDefaultAppResults(JSON.stringify(results))).toEqual(results);
  expect(defaultAppMessage(results)).toContain("mdx.type");
  expect(defaultAppMessage([results[0]!])).toBe("SimpleMD is the default for .md, .markdown, .mdown, .mkd.");
  expect(defaultAppMessage(results)).toContain("SimpleMD is the default for .md, .markdown, .mdown, .mkd.");
  expect(defaultAppMessage(results.map(result => ({ ...result, success: true })))).toBe("SimpleMD is the default for .md, .markdown, .mdown, .mkd, .mdx.");
  for (const raw of ["[]", "{}", "null", '[{"type":"md","success":true}]']) expect(() => parseDefaultAppResults(raw)).toThrow();
});
test("Windows default-app action opens only the OS settings page", async () => {
  const urls: string[] = [];
  const message = await setDefaultMarkdownApp({ platform: "win32", packaged: true, resources: "/unused", executable: "/unused", openExternal: async url => { urls.push(url); } });
  expect(urls).toEqual(["ms-settings:defaultapps"]); expect(message).toContain(".md, .markdown and .mdx");
});

test("macOS default-app helper has a bounded execution time", async () => {
  let timeout = 0;
  await setDefaultMarkdownApp({ platform: "darwin", packaged: true, resources: "/fixture", executable: "/fixture/SimpleMD.app/Contents/MacOS/SimpleMD", openExternal: async () => {} }, async (_helper, _args, options) => {
    timeout = options.timeout;
    return { stdout: JSON.stringify([{ type: "net.daringfireball.markdown", extensions: ["md"], handler: "/fixture/SimpleMD.app", success: true, error: null }]) };
  });
  expect(timeout).toBe(10_000);
});

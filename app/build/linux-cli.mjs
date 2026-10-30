import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { appDir } from "./native.mjs";

const require = createRequire(import.meta.url);
const templates = path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates/linux");

export async function withLinuxCliHooks(config, build) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "simplemd-deb-hooks-"));
  try {
    const deb = { ...config.deb };
    for (const [key, name] of [["afterInstall", "after-install"], ["afterRemove", "after-remove"]]) {
      const defaults = readFileSync(path.join(templates, `${name}.tpl`), "utf8");
      const cli = readFileSync(path.join(appDir, "build", `linux-${name}.sh`), "utf8");
      const target = path.join(scratch, `${name}.sh`);
      writeFileSync(target, defaults + "\n" + cli);
      deb[key] = target;
    }
    return await build({ ...config, deb });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

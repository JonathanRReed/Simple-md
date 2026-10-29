import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const out = "dist";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/renderer`, { recursive: true });

async function bundle(config: Parameters<typeof Bun.build>[0]) {
  const res = await Bun.build(config);
  if (!res.success) {
    for (const log of res.logs) console.error(log);
    process.exit(1);
  }
}

await bundle({
  entrypoints: ["src/main/main.ts", "src/main/render-worker.ts"],
  outdir: out,
  target: "node",
  format: "esm",
  splitting: true,
  external: ["electron"],
  naming: { entry: "[name].mjs", chunk: "chunks/[name]-[hash].mjs", asset: "chunks/[name]-[hash].[ext]" },
});

await Bun.write(`${out}/main-app.mjs`, Bun.file(`${out}/main.mjs`));
await writeFile(`${out}/main.mjs`, `import { enableCompileCache } from "node:module";
try { enableCompileCache?.(); } catch {}
await import("./main-app.mjs");
`);

await bundle({
  entrypoints: ["src/preload.ts"],
  outdir: out,
  target: "node",
  format: "cjs",
  external: ["electron"],
  naming: "preload.cjs",
});

await bundle({ entrypoints: ["src/settings-preload.ts"], outdir: out, target: "node", format: "cjs", external: ["electron"], naming: "settings-preload.cjs" });

await bundle({
  entrypoints: ["src/renderer/app.ts", "src/renderer/settings.ts"],
  outdir: `${out}/renderer`,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
});


await cp("src/renderer/index.html", `${out}/renderer/index.html`);
await cp("src/renderer/style.css", `${out}/renderer/style.css`);
await cp("src/renderer/motion.css", `${out}/renderer/motion.css`);
await cp("node_modules/katex/dist/katex.min.css", `${out}/renderer/katex.min.css`);
await cp("node_modules/katex/dist/fonts", `${out}/renderer/fonts`, { recursive: true });
await cp("assets", `${out}/assets`, { recursive: true });

await cp("src/renderer/settings.html", `${out}/renderer/settings.html`);
await cp("src/renderer/settings.css", `${out}/renderer/settings.css`);
